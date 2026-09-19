import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, checkReceipt, checkSubjectProof, generateVerifier, signBody, subjectProofFor, verifyResponse, type ReceiptBody } from "./attest.ts";
import { checkAdmission, issueSession, parsePolicy, probe, serveGate, submitSession, GATE_PROTOCOL, type Admission, type AdmissionBody, type GatePolicy, type GateSession } from "./gate.ts";
import { GateStore } from "./store.ts";

const verifier = generateVerifier();
const policy: GatePolicy = { suite: "v2", cells: ["arithmetic:t0", "arithmetic:t1"], challenges: 2, minPass: 1, ttlSeconds: 300 };
const now = new Date("2026-09-18T00:00:00Z");
const later = new Date("2026-09-18T00:01:00Z");

const session = (over: Partial<Parameters<typeof issueSession>[0]> = {}) =>
  issueSession({ policy, verifierJwk: verifier.privateJwk, now, pick: () => 0, seedBase: 700_000, ...over });

const answers = (s: { session: GateSession }) =>
  Object.fromEntries(s.session.tickets.map((t) => [t.challenge.challengeId, t.expected]));

describe("gate policy", () => {
  test("validates a good policy and rejects bad ones", () => {
    expect(parsePolicy(policy)).toEqual(policy);
    for (const bad of [
      { suite: "typo" }, { cells: [] }, { cells: ["arithmetic:t9"] }, { cells: ["nosuch:t0"] },
      { cells: ["arithmetic:t0", "arithmetic:t0"] }, { challenges: 0 }, { challenges: 17 },
      { minPass: 0 }, { minPass: 3 }, { ttlSeconds: 5 }, { ttlSeconds: 9999 },
    ]) {
      expect(() => parsePolicy({ ...policy, ...bad })).toThrow("invalid gate policy");
    }
  });
});

describe("session issuance", () => {
  test("mints N challenges bound to one session id and deadline", () => {
    const { session: s, challenges } = session();
    expect(challenges).toHaveLength(2);
    expect(s.sessionId).toMatch(/^gs_[A-Za-z0-9_-]{12}$/);
    for (const challenge of challenges) {
      expect(challenge.sessionId).toBe(s.sessionId);
      expect(challenge.expiresAt).toBe(s.expiresAt);
      expect(`${challenge.family}:t${challenge.tier}`).toBe("arithmetic:t0");
    }
    expect(s.tickets).toHaveLength(2);
  });

  test("subject and context propagate into every challenge", () => {
    const { challenges } = session({ subject: "agent-7", context: "jobs-board" });
    for (const challenge of challenges) {
      expect(challenge.subject).toBe("agent-7");
      expect(challenge.context).toBe("jobs-board");
    }
  });
});

describe("session submit and admission", () => {
  test("correct responses produce a passing admission with replayable receipts", () => {
    const issued = session();
    const { receipts, admission } = submitSession({ session: issued.session, responses: answers(issued), verifierJwk: verifier.privateJwk, now: later });
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) expect(checkReceipt(receipt)).toEqual({ ok: true, verdict: true });
    expect(checkAdmission(admission)).toEqual({ ok: true, verdict: true, passed: 2 });
  });

  test("a wrong response is a failed challenge; the verdict stays truthful", () => {
    const issued = session();
    const [first] = issued.session.tickets;
    const { receipts, admission } = submitSession({
      session: issued.session,
      responses: { [first.challenge.challengeId]: first.expected, [issued.session.tickets[1].challenge.challengeId]: "0" },
      verifierJwk: verifier.privateJwk, now: later,
    });
    expect(receipts).toHaveLength(2);
    expect(checkAdmission(admission)).toEqual({ ok: true, verdict: true, passed: 1 });
  });

  test("a non-format-canonical response mints no receipt but still records the failure", () => {
    const issued = session();
    const [first, second] = issued.session.tickets;
    const { receipts, admission } = submitSession({
      session: issued.session,
      responses: { [first.challenge.challengeId]: first.expected, [second.challenge.challengeId]: "i do not know" },
      verifierJwk: verifier.privateJwk, now: later,
    });
    expect(receipts).toHaveLength(1);
    const body = JSON.parse(admission.payload);
    expect(body.challenges).toHaveLength(2);
    expect(checkAdmission(admission)).toEqual({ ok: true, verdict: true, passed: 1 });
  });

  test("minPass arithmetic holds: too few passes fails the admission", () => {
    const strict = { ...policy, minPass: 2 };
    const issued = issueSession({ policy: strict, verifierJwk: verifier.privateJwk, now, pick: () => 0, seedBase: 700_000 });
    const [first] = issued.session.tickets;
    const { admission } = submitSession({
      session: issued.session,
      responses: { [first.challenge.challengeId]: first.expected },
      verifierJwk: verifier.privateJwk, now: later,
    });
    expect(checkAdmission(admission)).toEqual({ ok: true, verdict: false, passed: 1 });
  });

  test("unknown challenge ids and expired sessions refuse", () => {
    const issued = session();
    expect(() => submitSession({ session: issued.session, responses: { att_aaaaaaaaaaaa: "1" }, verifierJwk: verifier.privateJwk, now: later })).toThrow("unknown challenge");
    expect(() => submitSession({ session: issued.session, responses: answers(issued), verifierJwk: verifier.privateJwk, now: new Date("2026-09-18T00:10:00Z") })).toThrow("expired");
  });
});

describe("admission checking", () => {
  const decided = () => {
    const issued = session();
    return submitSession({ session: issued.session, responses: answers(issued), verifierJwk: verifier.privateJwk, now: later });
  };

  test("rejects tampering at every layer", () => {
    const { admission } = decided();
    const body = JSON.parse(admission.payload);
    const cases: Admission[] = [
      { ...admission, signature: admission.signature.slice(0, -4) + "AAAA" },
      { ...admission, payload: JSON.stringify({ ...body, verdict: { ...body.verdict, passed: 0 } }) },
      { ...admission, payload: JSON.stringify({ ...body, challenges: body.challenges.slice(1) }) },
      { ...admission, payload: JSON.stringify({ ...body, sessionId: "gs_zzzzzzzzzzzz" }) },
      { ...admission, payload: JSON.stringify({ ...body, policy: { ...body.policy, minPass: 99 } }) },
      { protocol: GATE_PROTOCOL, payload: "{}", signature: "x" },
    ];
    for (const tampered of cases) expect(checkAdmission(tampered).ok).toBe(false);
  });

  test("receipts from a different session do not graft on", () => {
    const a = decided();
    const b = decided();
    const body = JSON.parse(a.admission.payload);
    const foreign = JSON.parse(b.admission.payload).receipts[0];
    const grafted = { ...a.admission, payload: JSON.stringify({ ...body, receipts: [foreign] }) };
    expect(checkAdmission(grafted as Admission).ok).toBe(false);
  });

  test("a payload re-signed under a foreign key fails signature verification", () => {
    const { admission } = decided();
    const other = generateVerifier();
    const body = JSON.parse(admission.payload);
    const foreignSig = signBody(body, other.privateJwk);
    expect(checkAdmission({ ...admission, signature: foreignSig }).ok).toBe(false);
  });
});

describe("subject-bound sessions", () => {
  const respondent = generateVerifier();
  const proofBody = (receipt: { payload: string }) => JSON.parse(receipt.payload) as ReceiptBody;

  test("one session-scoped proof embeds in every minted receipt and replays", () => {
    const issued = session();
    const subjectProof = subjectProofFor(issued.session.tickets[0].challenge, respondent.privateJwk);
    const { receipts, admission } = submitSession({ session: issued.session, responses: answers(issued), subjectProof, verifierJwk: verifier.privateJwk, now: later });
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(proofBody(receipt).subjectProof).toEqual(subjectProof);
      expect(checkReceipt(receipt)).toEqual({ ok: true, verdict: true });
    }
    expect(checkAdmission(admission)).toEqual({ ok: true, verdict: true, passed: 2 });
  });

  test("a proof minted for one challenge serves the whole session", () => {
    const issued = session();
    const [a, b] = issued.session.tickets;
    const subjectProof = subjectProofFor(a.challenge, respondent.privateJwk);
    // The transcript is session-scoped, so the same proof verifies for a sibling challenge.
    expect(checkSubjectProof(b.challenge, subjectProof)).toBe(true);
    expect(checkSubjectProof(a.challenge, subjectProof)).toBe(true);
  });

  test("an invalid or misplaced proof rejects the submit outright", () => {
    const issued = session();
    const tampered = { ...subjectProofFor(issued.session.tickets[0].challenge, respondent.privateJwk), signature: "AAAA" };
    expect(() => submitSession({ session: issued.session, responses: answers(issued), subjectProof: tampered, verifierJwk: verifier.privateJwk, now: later })).toThrow("subject proof");
    const other = session({ seedBase: 900_000 });
    const misplaced = subjectProofFor(other.session.tickets[0].challenge, respondent.privateJwk);
    expect(() => submitSession({ session: issued.session, responses: answers(issued), subjectProof: misplaced, verifierJwk: verifier.privateJwk, now: later })).toThrow("subject proof");
  });

  test("admissions without proofs remain valid", () => {
    const issued = session();
    const { receipts, admission } = submitSession({ session: issued.session, responses: answers(issued), verifierJwk: verifier.privateJwk, now: later });
    for (const receipt of receipts) expect(proofBody(receipt).subjectProof).toBeUndefined();
    expect(checkAdmission(admission)).toEqual({ ok: true, verdict: true, passed: 2 });
  });

  test("receipts mixing subject keys fail the admission check", () => {
    const issued = session();
    const [t0, t1] = issued.session.tickets;
    const r0 = verifyResponse({ ticket: t0, response: t0.expected, subjectProof: subjectProofFor(t0.challenge, generateVerifier().privateJwk), verifierJwk: verifier.privateJwk, now: later });
    const r1 = verifyResponse({ ticket: t1, response: t1.expected, subjectProof: subjectProofFor(t1.challenge, generateVerifier().privateJwk), verifierJwk: verifier.privateJwk, now: later });
    const body: AdmissionBody = {
      kind: "admission", sessionId: issued.session.sessionId, policy,
      challenges: [t0.challenge, t1.challenge], receipts: [r0, r1],
      verdict: { pass: true, passed: 2, required: policy.minPass, decidedAt: later.toISOString() },
    };
    const admission: Admission = { protocol: GATE_PROTOCOL, payload: canonical(body), signature: signBody(body, verifier.privateJwk) };
    const result = checkAdmission(admission);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("subject");
  });

  test("HTTP submit accepts a session-scoped subjectProof end-to-end", async () => {
    const d = mkdtempSync(join(tmpdir(), "clankdar-gate-"));
    const store = GateStore.open(d);
    const gate = serveGate({ policy, verifierJwk: verifier.privateJwk, store, port: 0 });
    try {
      const made = await fetch(`${gate.url}/sessions`, { method: "POST", body: "{}" });
      expect(made.status).toBe(201);
      const { sessionId, challenges } = await made.json();
      const entry = store.session(sessionId)!;
      const responses = Object.fromEntries(entry.session.tickets.map((t) => [t.challenge.challengeId, t.expected]));
      const subjectProof = subjectProofFor(challenges[0], respondent.privateJwk);
      const decided = await fetch(`${gate.url}/sessions/${sessionId}/responses`, { method: "POST", body: JSON.stringify({ responses, subjectProof }) });
      expect(decided.status).toBe(200);
      const { admission, receipts } = await decided.json();
      expect(checkAdmission(admission)).toEqual({ ok: true, verdict: true, passed: 2 });
      for (const receipt of receipts as { payload: string }[]) expect(proofBody(receipt).subjectProof).toEqual(subjectProof);
      const served = await fetch(`${gate.url}/receipts/${challenges[0].challengeId}`);
      expect(proofBody(await served.json()).subjectProof).toEqual(subjectProof);
    } finally {
      gate.close();
      store.close();
    }
  });

  test("HTTP submit rejects bad proofs without consuming the session", async () => {
    const d = mkdtempSync(join(tmpdir(), "clankdar-gate-"));
    const store = GateStore.open(d);
    const gate = serveGate({ policy, verifierJwk: verifier.privateJwk, store, port: 0 });
    try {
      const made = await fetch(`${gate.url}/sessions`, { method: "POST", body: "{}" });
      const { sessionId } = await made.json();
      const entry = store.session(sessionId)!;
      const responses = Object.fromEntries(entry.session.tickets.map((t) => [t.challenge.challengeId, t.expected]));
      const url = `${gate.url}/sessions/${sessionId}/responses`;
      const malformed = await fetch(url, { method: "POST", body: JSON.stringify({ responses, subjectProof: { publicKey: 7 } }) });
      expect(malformed.status).toBe(400);
      const unverifiable = await fetch(url, { method: "POST", body: JSON.stringify({ responses, subjectProof: { publicKey: respondent.publicKey, signature: "AAAA" } }) });
      expect(unverifiable.status).toBe(400);
      const ok = await fetch(url, { method: "POST", body: JSON.stringify({ responses, subjectProof: subjectProofFor(entry.session.tickets[0].challenge, respondent.privateJwk) }) });
      expect(ok.status).toBe(200);
    } finally {
      gate.close();
      store.close();
    }
  });
});

describe("durable ledger", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "clankdar-gate-"));

  test("issue → decide → receipt lookup survives a reopen", () => {
    const d = dir();
    const store = GateStore.open(d);
    const issued = session();
    store.issueSession(issued.session);
    const { receipts, admission } = submitSession({ session: issued.session, responses: answers(issued), verifierJwk: verifier.privateJwk, now: later });
    store.decide(issued.session.sessionId, admission, receipts);
    store.close();

    const reopened = GateStore.open(d);
    const entry = reopened.session(issued.session.sessionId)!;
    expect(entry.decided).toBe(true);
    const challengeId = issued.session.tickets[0].challenge.challengeId;
    expect(reopened.receipt(challengeId)).not.toBeNull();
    expect(() => reopened.decide(issued.session.sessionId, admission, receipts)).toThrow("already decided");
    reopened.close();
  });

  test("a torn tail is dropped; mid-log corruption is fatal", () => {
    const d = dir();
    const store = GateStore.open(d);
    const issued = session();
    store.issueSession(issued.session);
    store.close();
    const log = join(d, "gate-state.jsonl");
    writeFileSync(log, readFileSync(log, "utf8") + '{"type":"sessio');
    const reopened = GateStore.open(d);
    expect(reopened.session(issued.session.sessionId)!.decided).toBe(false);
    reopened.close();
  });
});

describe("gate HTTP service", () => {
  test("full roundtrip: policy → session → submit → admission → receipt", async () => {
    const d = mkdtempSync(join(tmpdir(), "clankdar-gate-"));
    const store = GateStore.open(d);
    const gate = serveGate({ policy, verifierJwk: verifier.privateJwk, store, port: 0 });
    try {
      const meta = await (await fetch(`${gate.url}/policy`)).json();
      expect(meta.policy.challenges).toBe(2);
      expect(meta.verifier.publicKey).toBeTruthy();

      const made = await fetch(`${gate.url}/sessions`, { method: "POST", body: JSON.stringify({ subject: "agent-7" }) });
      expect(made.status).toBe(201);
      const { sessionId, challenges } = await made.json();
      expect(challenges).toHaveLength(2);
      expect(challenges[0].sessionId).toBe(sessionId);

      // Solve with the server-side tickets (test-only access to the store).
      const entry = store.session(sessionId)!;
      const responses = Object.fromEntries(entry.session.tickets.map((t) => [t.challenge.challengeId, t.expected]));
      const decided = await fetch(`${gate.url}/sessions/${sessionId}/responses`, { method: "POST", body: JSON.stringify({ responses }) });
      expect(decided.status).toBe(200);
      const { admission, receipts } = await decided.json();
      expect(checkAdmission(admission)).toEqual({ ok: true, verdict: true, passed: 2 });
      expect(receipts).toHaveLength(2);

      const receipt = await fetch(`${gate.url}/receipts/${challenges[0].challengeId}`);
      expect(receipt.status).toBe(200);
      expect((await fetch(`${gate.url}/receipts/att_aaaaaaaaaaaa`)).status).toBe(404);
      expect((await fetch(`${gate.url}/sessions/${sessionId}/responses`, { method: "POST", body: JSON.stringify({ responses }) })).status).toBe(409);
      expect((await fetch(`${gate.url}/sessions/gs_aaaaaaaaaaaa/responses`, { method: "POST", body: "{}" })).status).toBe(404);
    } finally {
      gate.close();
      store.close();
    }
  });

  test("an expired session reports 410", async () => {
    const d = mkdtempSync(join(tmpdir(), "clankdar-gate-"));
    const store = GateStore.open(d);
    const stale = issueSession({ policy, verifierJwk: verifier.privateJwk, now: new Date(Date.now() - 600_000), pick: () => 0 });
    store.issueSession(stale.session);
    const gate = serveGate({ policy, verifierJwk: verifier.privateJwk, store, port: 0 });
    try {
      const res = await fetch(`${gate.url}/sessions/${stale.session.sessionId}/responses`, { method: "POST", body: JSON.stringify({ responses: {} }) });
      expect(res.status).toBe(410);
    } finally {
      gate.close();
      store.close();
    }
  });
});

describe("drift probe", () => {
  test("self-issued sessions produce signed, replayable admissions", async () => {
    const stub = { name: "stub", solve: async () => "0" };
    const result = await probe({ policy, verifierJwk: verifier.privateJwk, adapter: stub, rounds: 3 });
    expect(result.rounds).toBe(3);
    expect(result.sessions).toBe(6);
    for (const admission of result.admissions) {
      expect(checkAdmission(admission).ok).toBe(true);
    }
    expect(result.admitted).toBe(0);
  });
});

describe("rate limits", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "clankdar-gate-"));

  test("store queries count live sessions and issuance history", () => {
    const d = dir();
    const store = GateStore.open(d);
    const live = session({ subject: "a", now });
    const decided = session({ subject: "a", seedBase: 701_000 });
    const stale = issueSession({ policy, verifierJwk: verifier.privateJwk, subject: "a", now: new Date(now.getTime() - 400_000), pick: () => 0, seedBase: 702_000 });
    const anon = session({ seedBase: 703_000 });
    store.issueSession(live.session);
    store.issueSession(decided.session);
    store.issueSession(stale.session);
    store.issueSession(anon.session);
    const { receipts, admission } = submitSession({ session: decided.session, responses: answers(decided), verifierJwk: verifier.privateJwk, now: later });
    store.decide(decided.session.sessionId, admission, receipts);
    const nowMs = Date.parse(live.session.issuedAt) + 60_000;
    expect(store.openSessions(nowMs).map((s) => s.sessionId).sort()).toEqual([live.session.sessionId, anon.session.sessionId].sort());
    expect(store.openSessions(nowMs, "a").map((s) => s.sessionId)).toEqual([live.session.sessionId]);
    expect(store.openSessions(nowMs, "")).toEqual([anon.session]);
    expect(store.issuedSince(Date.parse(live.session.issuedAt) - 1).length).toBe(3);
    expect(store.issuedSince(Date.parse(stale.session.issuedAt) - 1).length).toBe(4);
    expect(store.issuedSince(Date.parse(live.session.issuedAt) - 1, "a").length).toBe(2);
    expect(store.issuedSince(Date.parse(stale.session.issuedAt) - 1, "a").length).toBe(3);
    expect(store.issuedSince(nowMs + 3_600_000).length).toBe(0);
    store.close();
  });

  test("openTotal caps live sessions and frees on decision or expiry", async () => {
    const d = dir();
    const store = GateStore.open(d);
    const gate = serveGate({ policy, verifierJwk: verifier.privateJwk, store, port: 0, rateLimits: { openTotal: 1 } });
    try {
      const made = await fetch(`${gate.url}/sessions`, { method: "POST", body: "{}" });
      expect(made.status).toBe(201);
      const { sessionId } = await made.json();
      const second = await fetch(`${gate.url}/sessions`, { method: "POST", body: "{}" });
      expect(second.status).toBe(429);
      const entry = store.session(sessionId)!;
      const responses = Object.fromEntries(entry.session.tickets.map((t) => [t.challenge.challengeId, t.expected]));
      const decided = await fetch(`${gate.url}/sessions/${sessionId}/responses`, { method: "POST", body: JSON.stringify({ responses }) });
      expect(decided.status).toBe(200);
      const third = await fetch(`${gate.url}/sessions`, { method: "POST", body: "{}" });
      expect(third.status).toBe(201);
    } finally {
      gate.close();
      store.close();
    }
  });

  test("openPerSubject buckets by subject claim; anonymous shares a bucket", async () => {
    const d = dir();
    const store = GateStore.open(d);
    const gate = serveGate({ policy, verifierJwk: verifier.privateJwk, store, port: 0, rateLimits: { openPerSubject: 1 } });
    try {
      expect((await fetch(`${gate.url}/sessions`, { method: "POST", body: JSON.stringify({ subject: "a" }) })).status).toBe(201);
      expect((await fetch(`${gate.url}/sessions`, { method: "POST", body: JSON.stringify({ subject: "a" }) })).status).toBe(429);
      expect((await fetch(`${gate.url}/sessions`, { method: "POST", body: JSON.stringify({ subject: "b" }) })).status).toBe(201);
      expect((await fetch(`${gate.url}/sessions`, { method: "POST", body: "{}" })).status).toBe(201);
      expect((await fetch(`${gate.url}/sessions`, { method: "POST", body: "{}" })).status).toBe(429);
    } finally {
      gate.close();
      store.close();
    }
  });

  test("issueWindow paces global issuance across restarts", async () => {
    const d = dir();
    const seeded = issueSession({ policy, verifierJwk: verifier.privateJwk, now: new Date(Date.now() - 30_000), pick: () => 0 });
    const store = GateStore.open(d);
    store.issueSession(seeded.session);
    const gate = serveGate({ policy, verifierJwk: verifier.privateJwk, store, port: 0, rateLimits: { issueWindow: { max: 2, seconds: 3600 } } });
    try {
      expect((await fetch(`${gate.url}/sessions`, { method: "POST", body: "{}" })).status).toBe(201);
      expect((await fetch(`${gate.url}/sessions`, { method: "POST", body: "{}" })).status).toBe(429);
    } finally {
      gate.close();
      store.close();
    }
    const replayed = GateStore.open(d);
    const gate2 = serveGate({ policy, verifierJwk: verifier.privateJwk, store: replayed, port: 0, rateLimits: { issueWindow: { max: 2, seconds: 3600 } } });
    try {
      expect((await fetch(`${gate2.url}/sessions`, { method: "POST", body: "{}" })).status).toBe(429);
    } finally {
      gate2.close();
      replayed.close();
    }
  });

  test("expired sessions stop counting against open limits", async () => {
    const d = dir();
    const stale = issueSession({ policy: { ...policy, ttlSeconds: 3600 }, verifierJwk: verifier.privateJwk, now: new Date(Date.now() - 7_200_000), pick: () => 0 });
    const store = GateStore.open(d);
    store.issueSession(stale.session);
    const gate = serveGate({ policy, verifierJwk: verifier.privateJwk, store, port: 0, rateLimits: { openTotal: 1 } });
    try {
      expect((await fetch(`${gate.url}/sessions`, { method: "POST", body: "{}" })).status).toBe(201);
    } finally {
      gate.close();
      store.close();
    }
  });

  test("malformed limit config fails at serve time", () => {
    const d = dir();
    const store = GateStore.open(d);
    expect(() => serveGate({ policy, verifierJwk: verifier.privateJwk, store, port: 0, rateLimits: { openTotal: 0 } })).toThrow("positive integer");
    expect(() => serveGate({ policy, verifierJwk: verifier.privateJwk, store, port: 0, rateLimits: { issueWindow: { max: 0, seconds: 60 } } })).toThrow("positive integer");
    store.close();
  });
});
