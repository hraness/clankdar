import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonical, generateVerifier, signBody } from "./attest.ts";
import { issueSession, submitSession, type Admission, type GatePolicy, type GateSession } from "./gate.ts";
import { GateStore } from "./store.ts";
import {
  buildLog, checkLoggedAdmission, checkLog, proveSession, readLedger, TLOG_PROTOCOL,
  type TlogHead, type TransparencyLog,
} from "./tlog.ts";

const verifier = generateVerifier();
const other = generateVerifier();
const policy: GatePolicy = { suite: "v2", cells: ["arithmetic:t0", "arithmetic:t1"], challenges: 2, minPass: 1, ttlSeconds: 300 };
const now = new Date("2026-09-18T00:00:00Z");
const later = new Date("2026-09-18T00:01:00Z");
const built = new Date("2026-09-18T00:02:00Z");

const answersOf = (session: GateSession) =>
  Object.fromEntries(session.tickets.map((t) => [t.challenge.challengeId, t.expected]));

/** Write a real ledger through GateStore: `count` issued-and-decided sessions. */
const makeLedger = (count = 1) => {
  const dir = mkdtempSync(join(tmpdir(), "clankdar-tlog-"));
  const store = GateStore.open(dir);
  const sessions: GateSession[] = [];
  const admissions: Admission[] = [];
  for (let i = 0; i < count; i++) {
    const issued = issueSession({ policy, verifierJwk: verifier.privateJwk, now, pick: () => 0, seedBase: 700_000 + i * 100 });
    store.issueSession(issued.session);
    const { receipts, admission } = submitSession({
      session: issued.session, responses: answersOf(issued.session), verifierJwk: verifier.privateJwk, now: later,
    });
    store.decide(issued.session.sessionId, admission, receipts);
    sessions.push(issued.session);
    admissions.push(admission);
  }
  store.close();
  return { dir, sessions, admissions };
};

const makeLog = (count = 1): { log: TransparencyLog; sessions: GateSession[]; admissions: Admission[] } => {
  const ledger = makeLedger(count);
  return { log: buildLog({ dir: ledger.dir, verifierJwk: verifier.privateJwk, now: built }), ...ledger };
};

async function tlog(...args: string[]) {
  const proc = Bun.spawn([Bun.which("bun")!, resolve(import.meta.dir, "tlog.ts"), ...args], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

describe("tlog build and check", () => {
  test("build → check roundtrip over a real ledger", () => {
    const { log, sessions } = makeLog(2);
    expect(log.head.protocol).toBe(TLOG_PROTOCOL);
    expect(log.head.count).toBe(4);
    expect(log.entries.map((e) => e.type)).toEqual(["session", "decision", "session", "decision"]);
    expect(log.entries[0].prev).toBe("0".repeat(64));
    expect(log.entries[0].sessionId).toBe(sessions[0].sessionId);
    for (let i = 1; i < log.entries.length; i++) {
      expect(log.entries[i].prev).toBe(log.entries[i - 1].entryHash);
    }
    expect(log.head.head).toBe(log.entries.at(-1)!.entryHash);
    expect(checkLog(log)).toEqual({ ok: true, count: 4 });
  });

  test("an empty ledger produces a signed genesis head", () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-tlog-"));
    GateStore.open(dir).close();
    const log = buildLog({ dir, verifierJwk: verifier.privateJwk, now: built });
    expect(log.entries).toHaveLength(0);
    expect(log.head.count).toBe(0);
    expect(log.head.head).toBe("0".repeat(64));
    expect(checkLog(log)).toEqual({ ok: true, count: 0 });
  });

  test("a torn ledger tail is dropped; mid-log corruption is fatal", () => {
    const { dir } = makeLedger(1);
    const ledgerPath = join(dir, "gate-state.jsonl");
    appendFileSync(ledgerPath, '{"type":"sessio');
    expect(readLedger(dir)).toHaveLength(2);
    writeFileSync(ledgerPath, readFileSync(ledgerPath, "utf8").replace(/\n/, "\nnot-json\n"));
    expect(() => readLedger(dir)).toThrow("corrupt at record 2");
  });

  test("a decision for an unknown or decided session is fatal", () => {
    const { dir } = makeLedger(1);
    appendFileSync(join(dir, "gate-state.jsonl"), JSON.stringify({ type: "decision", sessionId: "gs_zzzzzzzzzzzz", admission: {}, receipts: [] }));
    expect(() => readLedger(dir)).toThrow("unknown or decided session");
  });
});

describe("tlog checking", () => {
  test("rejects tampering at every layer", () => {
    const { log } = makeLog(2);
    const cases: TransparencyLog[] = [
      // Entry body tampered — digest no longer recomputes to entryHash.
      { ...log, entries: log.entries.map((e, i) => (i === 1 ? { ...e, digest: "f".repeat(64) } : e)) },
      // Chain link tampered.
      { ...log, entries: log.entries.map((e, i) => (i === 2 ? { ...e, prev: "f".repeat(64) } : e)) },
      // Entry dropped — chain breaks and the count is wrong.
      { ...log, entries: log.entries.slice(0, -1) },
      // Session re-issued.
      { ...log, entries: [...log.entries, { ...log.entries[0], index: 4, prev: log.entries.at(-1)!.entryHash, entryHash: "a".repeat(64) }] },
      // Head count tampered.
      { ...log, head: { ...log.head, count: 99 } },
      // Head tip tampered.
      { ...log, head: { ...log.head, head: "b".repeat(64) } },
      // Head signature tampered.
      { ...log, head: { ...log.head, signature: log.head.signature.slice(0, -4) + "AAAA" } },
      // Wrong protocol.
      { ...log, head: { ...log.head, protocol: "clankdar-tlog-v0" as typeof TLOG_PROTOCOL } },
    ];
    for (const tampered of cases) expect(checkLog(tampered).ok).toBe(false);
  });

  test("a head re-signed under a foreign key fails", () => {
    const { log } = makeLog(1);
    const { signature: _drop, ...body } = log.head;
    const forged: TlogHead = { ...body, signature: signBody(body, other.privateJwk) };
    expect(checkLog({ ...log, head: forged }).ok).toBe(false);
  });

  test("a swapped verifier key fails keyId and signature", () => {
    const { log } = makeLog(1);
    const swapped = { ...log.head, verifier: { keyId: log.head.verifier.keyId, publicKey: other.publicKey } };
    expect(checkLog({ ...log, head: swapped }).ok).toBe(false);
    const selfConsistent = { ...log.head, verifier: { keyId: other.keyId, publicKey: other.publicKey } };
    expect(checkLog({ ...log, head: selfConsistent }).ok).toBe(false); // signature was made by the original key
  });
});

describe("tlog prove", () => {
  test("emits issuance and decision indexes under the signed head", () => {
    const { log, sessions } = makeLog(2);
    const proof = proveSession(log, sessions[1].sessionId);
    expect(proof).toEqual({ sessionId: sessions[1].sessionId, sessionIndex: 2, decisionIndex: 3, head: log.head });
    expect(() => proveSession(log, "gs_zzzzzzzzzzzz")).toThrow("not in the log");
  });

  test("an undecided session proves with a null decisionIndex", () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-tlog-"));
    const store = GateStore.open(dir);
    const issued = issueSession({ policy, verifierJwk: verifier.privateJwk, now, pick: () => 0, seedBase: 700_000 });
    store.issueSession(issued.session);
    store.close();
    const log = buildLog({ dir, verifierJwk: verifier.privateJwk, now: built });
    const proof = proveSession(log, issued.session.sessionId);
    expect(proof.sessionIndex).toBe(0);
    expect(proof.decisionIndex).toBeNull();
  });

  test("refuses to prove against a log that fails check", () => {
    const { log, sessions } = makeLog(1);
    const tampered = { ...log, head: { ...log.head, count: 7 } };
    expect(() => proveSession(tampered, sessions[0].sessionId)).toThrow("failed check");
  });
});

describe("tlog admit", () => {
  test("accepts a logged admission", () => {
    const { log, admissions } = makeLog(1);
    expect(checkLoggedAdmission(log, admissions[0])).toEqual({ ok: true, verdict: true, passed: 2 });
  });

  test("rejects a valid admission whose session never reached the log", () => {
    const { log } = makeLog(1);
    const foreign = makeLedger(1); // same verifier, different ledger
    const result = checkLoggedAdmission(log, foreign.admissions[0]);
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe(true); // the admission itself is valid — it is just unlogged
    expect(result.reason).toContain("not in the transparency log");
  });

  test("rejects a valid admission whose session is logged but undecided", () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-tlog-"));
    const store = GateStore.open(dir);
    const issued = issueSession({ policy, verifierJwk: verifier.privateJwk, now, pick: () => 0, seedBase: 700_000 });
    store.issueSession(issued.session); // issued, but the decision is never appended
    store.close();
    const { admission } = submitSession({ session: issued.session, responses: answersOf(issued.session), verifierJwk: verifier.privateJwk, now: later });
    const log = buildLog({ dir, verifierJwk: verifier.privateJwk, now: built });
    const result = checkLoggedAdmission(log, admission);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no logged decision");
  });

  test("rejects a bad admission and a tampered log alike", () => {
    const { log, admissions } = makeLog(1);
    expect(checkLoggedAdmission(log, { ...admissions[0], signature: "AAAA" }).ok).toBe(false);
    const tampered = { ...log, head: { ...log.head, head: "c".repeat(64) } };
    const result = checkLoggedAdmission(tampered, admissions[0]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("failed check");
  });
});

describe("tlog CLI", () => {
  test("build --out refuses to overwrite and check exits 2 on tampering", async () => {
    const { dir } = makeLedger(1);
    const keyFile = join(dir, "verifier.json");
    writeFileSync(keyFile, JSON.stringify(verifier.privateJwk));
    const out = join(dir, "tlog.json");

    const built = await tlog("build", "--dir", dir, "--key", keyFile, "--out", out);
    expect(built.code).toBe(0);
    const log = JSON.parse(readFileSync(out, "utf8")) as TransparencyLog;
    expect(log.entries).toHaveLength(2);

    expect((await tlog("build", "--dir", dir, "--key", keyFile, "--out", out)).code).not.toBe(0);
    expect((await tlog("check", out)).code).toBe(0);

    const tampered = join(dir, "tlog-tampered.json");
    writeFileSync(tampered, JSON.stringify({ ...log, head: { ...log.head, count: 9 } }));
    const bad = await tlog("check", tampered);
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.stdout).ok).toBe(false);
  });

  test("prove and admit round-trip through the CLI", async () => {
    const { dir, sessions, admissions } = makeLedger(1);
    const keyFile = join(dir, "verifier.json");
    const out = join(dir, "tlog.json");
    const admissionFile = join(dir, "admission.json");
    writeFileSync(keyFile, JSON.stringify(verifier.privateJwk));
    writeFileSync(admissionFile, JSON.stringify(admissions[0]));
    expect((await tlog("build", "--dir", dir, "--key", keyFile, "--out", out)).code).toBe(0);

    const proof = await tlog("prove", out, "--session", sessions[0].sessionId);
    expect(proof.code).toBe(0);
    expect(JSON.parse(proof.stdout).decisionIndex).toBe(1);
    expect((await tlog("prove", out, "--session", "gs_zzzzzzzzzzzz")).code).toBe(2);

    expect((await tlog("admit", out, admissionFile)).code).toBe(0);
    const foreign = makeLedger(1);
    const foreignFile = join(dir, "foreign.json");
    writeFileSync(foreignFile, JSON.stringify(foreign.admissions[0]));
    const denied = await tlog("admit", out, foreignFile);
    expect(denied.code).toBe(2);
    expect(JSON.parse(denied.stdout).ok).toBe(false);
  });
});
