import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonical, generateVerifier, signBody } from "./attest.ts";
import { issueSession, submitSession, type Admission, type GatePolicy, type GateSession } from "./gate.ts";
import { generatePool, type HoldoutPool } from "./holdout.ts";
import { GateStore } from "./store.ts";
import {
  buildLog, checkConsistency, checkLoggedAdmission, checkLog, compareLogs, CONSISTENCY_PROTOCOL,
  findEquivocation, isSignedHead, proveConsistency, proveSession,
  readHeads, readLedger, serveWitness, signHead, TLOG_PROTOCOL, witnessHead,
  type ConsistencyProof, type TlogHead, type TransparencyLog,
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

const makeHeldoutLog = (): { dir: string; log: TransparencyLog; admission: Admission; pool: HoldoutPool } => {
  const dir = mkdtempSync(join(tmpdir(), "clankdar-tlog-holdout-"));
  const pool = generatePool({ suite: "v2", cells: ["arithmetic:t0"] });
  const heldoutPolicy: GatePolicy = { suite: "v2", cells: ["h:arithmetic:t0"], challenges: 2, minPass: 1, ttlSeconds: 300 };
  const store = GateStore.open(dir);
  const issued = issueSession({ policy: heldoutPolicy, verifierJwk: verifier.privateJwk, pool, now, pick: () => 0, seedBase: 810_000 });
  store.issueSession(issued.session);
  const { receipts, admission } = submitSession({
    session: issued.session, responses: answersOf(issued.session), verifierJwk: verifier.privateJwk, pool, now: later,
  });
  store.decide(issued.session.sessionId, admission, receipts);
  store.close();
  return { dir, admission, pool, log: buildLog({ dir, verifierJwk: verifier.privateJwk, now: built }) };
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
    const lines = readFileSync(ledgerPath, "utf8").split("\n");
    lines.splice(1, 0, "not-json");
    writeFileSync(ledgerPath, lines.join("\n"));
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

  test("preserves held-out replayability and upgrades it with the disclosed pool", () => {
    const { log, admission, pool } = makeHeldoutLog();
    expect(checkLoggedAdmission(log, admission)).toEqual({ ok: true, verdict: true, passed: 2, unreplayed: 2 });
    expect(checkLoggedAdmission(log, admission, { pool })).toEqual({ ok: true, verdict: true, passed: 2 });
    const unlogged = checkLoggedAdmission(makeLog(1).log, admission);
    expect(unlogged).toMatchObject({ ok: false, verdict: true, passed: 2, unreplayed: 2 });
    expect(unlogged.reason).toContain("not in the transparency log");
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

  test("admit reports issuer-claimed held-out scores until --pool is disclosed", async () => {
    const { dir, log, admission, pool } = makeHeldoutLog();
    const logFile = join(dir, "holdout-log.json");
    const admissionFile = join(dir, "holdout-admission.json");
    const poolFile = join(dir, "holdout-pool.json");
    writeFileSync(logFile, JSON.stringify(log));
    writeFileSync(admissionFile, JSON.stringify(admission));
    writeFileSync(poolFile, JSON.stringify(pool));

    const claimed = await tlog("admit", logFile, admissionFile);
    expect(claimed.code).toBe(0);
    expect(JSON.parse(claimed.stdout)).toEqual({ ok: true, verdict: true, passed: 2, unreplayed: 2 });
    const replayed = await tlog("admit", logFile, admissionFile, "--pool", poolFile);
    expect(replayed.code).toBe(0);
    expect(JSON.parse(replayed.stdout)).toEqual({ ok: true, verdict: true, passed: 2 });
  });
});

/** A scratch heads-registry path inside a fresh temp dir. */
const makeHeadsPath = () => join(mkdtempSync(join(tmpdir(), "clankdar-heads-")), "heads.jsonl");

describe("tlog witness", () => {
  test("records a log's head once; re-witnessing is a no-op", () => {
    const { log } = makeLog(1);
    const heads = makeHeadsPath();
    const first = witnessHead(heads, log);
    expect(first).toMatchObject({ ok: true, recorded: true, keyId: verifier.keyId, count: 2, head: log.head.head, witnessed: 1 });
    const second = witnessHead(heads, log);
    expect(second).toMatchObject({ ok: true, recorded: false, witnessed: 1 });
    expect(readHeads(heads)).toEqual([log.head]);
    expect(statSync(heads).mode & 0o777).toBe(0o644); // public-adjacent evidence, not a secret
  });

  test("a reissued head is a new artifact, not a duplicate", () => {
    const { log } = makeLog(1);
    const heads = makeHeadsPath();
    witnessHead(heads, log);
    // Same issuer, same count and tip, new issuedAt + signature: a distinct
    // signed artifact, so it is recorded — and consistent, not a fork.
    const reissued = signHead(log.head.count, log.head.head, verifier.privateJwk, new Date("2026-09-18T00:03:00Z"));
    expect(witnessHead(heads, { ...log, head: reissued })).toMatchObject({ ok: true, recorded: true, witnessed: 2 });
    expect(readHeads(heads)).toHaveLength(2);
  });

  test("refuses a log that fails check and writes nothing", () => {
    const { log } = makeLog(1);
    const heads = makeHeadsPath();
    const result = witnessHead(heads, { ...log, head: { ...log.head, count: 9 } });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("failed check");
    expect(readHeads(heads)).toHaveLength(0);
  });

  test("registry replay: torn tail dropped, mid corruption and invalid heads fatal", () => {
    const { log } = makeLog(1);
    const heads = makeHeadsPath();
    witnessHead(heads, log);
    appendFileSync(heads, '{"kind":"he'); // torn tail from a crashed append
    expect(readHeads(heads)).toHaveLength(1);
    appendFileSync(heads, "\n" + JSON.stringify(log.head) + "\n"); // the torn piece is mid-file now
    expect(() => readHeads(heads)).toThrow("corrupt at line 2");
    writeFileSync(heads, JSON.stringify(log.head) + "\n" + JSON.stringify({ hello: "world" }) + "\n");
    expect(() => readHeads(heads)).toThrow("invalid head at line 2");
    writeFileSync(heads, JSON.stringify({ ...log.head, signature: "AAAA" }) + "\n");
    expect(() => readHeads(heads)).toThrow("invalid head at line 1");
  });

  test("registry refuses files over the line bound", () => {
    const { log } = makeLog(1);
    const heads = makeHeadsPath();
    writeFileSync(heads, Array(4).fill(JSON.stringify(log.head)).join("\n") + "\n");
    expect(readHeads(heads, 4)).toHaveLength(4);
    expect(() => readHeads(heads, 3)).toThrow("exceeds 3 lines");
  });

  test("isSignedHead validates shape, keyId, and signature", () => {
    const { log } = makeLog(1);
    expect(isSignedHead(log.head)).toBe(true);
    expect(isSignedHead({ ...log.head, signature: "AAAA" })).toBe(false);
    expect(isSignedHead({ ...log.head, count: -1 })).toBe(false);
    expect(isSignedHead({ ...log.head, verifier: { keyId: log.head.verifier.keyId, publicKey: other.publicKey } })).toBe(false);
    expect(isSignedHead("head")).toBe(false);
  });
});

describe("tlog equivocate", () => {
  test("same keyId, same count, different tips is a proven fork", () => {
    const a = signHead(4, "a".repeat(64), verifier.privateJwk, now);
    const b = signHead(4, "b".repeat(64), verifier.privateJwk, later);
    const report = findEquivocation([a, b]);
    expect(report.ok).toBe(false);
    expect(report.keyId).toBe(verifier.keyId);
    expect(report.conflict).toEqual([a, b]);
    expect(report.reason).toContain("different tips");
  });

  test("one tip signed at two counts is a proven fork", () => {
    const a = signHead(4, "a".repeat(64), verifier.privateJwk, now);
    const b = signHead(6, "a".repeat(64), verifier.privateJwk, later);
    const report = findEquivocation([a, b]);
    expect(report.ok).toBe(false);
    expect(report.conflict).toEqual([a, b]);
    expect(report.reason).toContain("counts 4 and 6");
  });

  test("consistent heads — extensions and reissues — are clean", () => {
    const a = signHead(2, "a".repeat(64), verifier.privateJwk, now);
    const reissued = signHead(2, "a".repeat(64), verifier.privateJwk, later); // same claim again
    const extended = signHead(4, "b".repeat(64), verifier.privateJwk, built); // longer log, new tip
    expect(findEquivocation([a, reissued, extended])).toEqual({ ok: true, checked: 3 });
  });

  test("a count that regresses in issue order warns without failing", () => {
    const a = signHead(6, "a".repeat(64), verifier.privateJwk, now);
    const b = signHead(4, "b".repeat(64), verifier.privateJwk, later);
    const report = findEquivocation([a, b]);
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([{ keyId: verifier.keyId, conflict: [a, b], reason: "head counts regress" }]);
  });

  test("issue order decides the warning, not registry order", () => {
    const a = signHead(6, "a".repeat(64), verifier.privateJwk, later); // recorded first, issued last
    const b = signHead(4, "b".repeat(64), verifier.privateJwk, now);
    // Registry order regresses but issuedAt order is monotone: no warning.
    expect(findEquivocation([a, b])).toEqual({ ok: true, checked: 2 });
  });

  test("heads under different keyIds never conflict", () => {
    const a = signHead(4, "a".repeat(64), verifier.privateJwk, now);
    const b = signHead(4, "b".repeat(64), other.privateJwk, now);
    const c = signHead(2, "c".repeat(64), other.privateJwk, later);
    const report = findEquivocation([a, b, c]);
    expect(report.ok).toBe(true);
    // `other` does regress in issue order, though — warnings are per keyId too.
    expect(report.warnings).toEqual([{ keyId: other.keyId, conflict: [b, c], reason: "head counts regress" }]);
  });
});

describe("tlog witness/equivocate CLI", () => {
  test("witness → equivocate round-trip; a forked registry exits 2", async () => {
    const { dir } = makeLedger(1);
    const keyFile = join(dir, "verifier.json");
    const out = join(dir, "tlog.json");
    const heads = join(dir, "heads.jsonl");
    writeFileSync(keyFile, JSON.stringify(verifier.privateJwk));
    expect((await tlog("build", "--dir", dir, "--key", keyFile, "--out", out)).code).toBe(0);

    const first = await tlog("witness", "--heads", heads, out);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ ok: true, recorded: true, keyId: verifier.keyId, count: 2, witnessed: 1 });
    expect(JSON.parse((await tlog("witness", "--heads", heads, out)).stdout).recorded).toBe(false);
    expect(statSync(heads).mode & 0o777).toBe(0o644);

    const clean = await tlog("equivocate", "--heads", heads);
    expect(clean.code).toBe(0);
    expect(JSON.parse(clean.stdout)).toEqual({ ok: true, checked: 1 });

    // A second log of the same length from a different ledger is a certain fork.
    const foreign = makeLedger(1);
    const foreignKey = join(foreign.dir, "verifier.json");
    const foreignOut = join(foreign.dir, "tlog.json");
    writeFileSync(foreignKey, JSON.stringify(verifier.privateJwk));
    expect((await tlog("build", "--dir", foreign.dir, "--key", foreignKey, "--out", foreignOut)).code).toBe(0);
    expect(JSON.parse((await tlog("witness", "--heads", heads, foreignOut)).stdout).recorded).toBe(true);

    const forked = await tlog("equivocate", "--heads", heads);
    expect(forked.code).toBe(2);
    const report = JSON.parse(forked.stdout);
    expect(report.ok).toBe(false);
    expect(report.keyId).toBe(verifier.keyId);
    expect(report.conflict).toHaveLength(2);
    expect(report.reason).toContain("different tips");
  });

  test("witness refuses a tampered log and equivocate accepts an empty registry", async () => {
    const { dir } = makeLedger(1);
    const keyFile = join(dir, "verifier.json");
    const out = join(dir, "tlog.json");
    const heads = join(dir, "heads.jsonl");
    writeFileSync(keyFile, JSON.stringify(verifier.privateJwk));
    expect((await tlog("build", "--dir", dir, "--key", keyFile, "--out", out)).code).toBe(0);
    const log = JSON.parse(readFileSync(out, "utf8")) as TransparencyLog;

    const tampered = join(dir, "tampered.json");
    writeFileSync(tampered, JSON.stringify({ ...log, head: { ...log.head, count: 9 } }));
    const bad = await tlog("witness", "--heads", heads, tampered);
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.stdout).ok).toBe(false);
    expect((await tlog("equivocate", "--heads", heads)).code).toBe(0); // nothing was recorded
    expect(JSON.parse((await tlog("equivocate", "--heads", join(dir, "absent.jsonl"))).stdout)).toEqual({ ok: true, checked: 0 });
  });
});

describe("tlog compare", () => {
  test("identical chains are consistent — a reissued head is not a fork", () => {
    const { dir } = makeLedger(2);
    const first = buildLog({ dir, verifierJwk: verifier.privateJwk, now });
    const reissued = buildLog({ dir, verifierJwk: verifier.privateJwk, now: later });
    expect(first.head.signature).not.toBe(reissued.head.signature); // different heads, same chain
    expect(compareLogs(first, reissued)).toMatchObject({ ok: true, equivocation: false, keyId: verifier.keyId, relation: "identical", counts: [4, 4] });
  });

  test("growth is a strict prefix, not a fork", () => {
    const { dir } = makeLedger(1);
    const short = buildLog({ dir, verifierJwk: verifier.privateJwk, now });
    const store = GateStore.open(dir);
    const second = issueSession({ policy, verifierJwk: verifier.privateJwk, now, pick: () => 0, seedBase: 920_000 });
    store.issueSession(second.session);
    const decided = submitSession({ session: second.session, responses: answersOf(second.session), verifierJwk: verifier.privateJwk, now: later });
    store.decide(second.session.sessionId, decided.admission, decided.receipts);
    store.close();
    const long = buildLog({ dir, verifierJwk: verifier.privateJwk, now: built });
    expect(compareLogs(short, long)).toMatchObject({ ok: true, equivocation: false, relation: "a-prefix-of-b", counts: [2, 4] });
    expect(compareLogs(long, short)).toMatchObject({ ok: true, equivocation: false, relation: "b-prefix-of-a", counts: [4, 2] });
  });

  test("two independently-run ledgers fork at index 0", () => {
    const report = compareLogs(makeLog(1).log, makeLog(1).log);
    expect(report).toMatchObject({ ok: false, equivocation: true, keyId: verifier.keyId, forkIndex: 0, counts: [2, 2] });
  });

  test("a shared prefix then divergence finds the real fork index — undecidable from heads", () => {
    // The same issued+decided records written into two ledgers commit the
    // same digests, so both chains share entries 0..1. Each ledger then
    // continues differently — A gets one more session, B gets two — so
    // both chains have an entry at index 2 committing different content.
    // The heads alone (count 4 vs 6, different tips) are exactly the case
    // findEquivocation cannot decide; the chains decide it at index 2.
    const shared = issueSession({ policy, verifierJwk: verifier.privateJwk, now, pick: () => 0, seedBase: 910_000 });
    const sharedDecision = submitSession({ session: shared.session, responses: answersOf(shared.session), verifierJwk: verifier.privateJwk, now: later });
    const dirA = mkdtempSync(join(tmpdir(), "clankdar-tlog-"));
    const dirB = mkdtempSync(join(tmpdir(), "clankdar-tlog-"));
    for (const [dir, seeds] of [[dirA, [910_100]], [dirB, [910_200, 910_300]]] as const) {
      const store = GateStore.open(dir);
      store.issueSession(shared.session);
      store.decide(shared.session.sessionId, sharedDecision.admission, sharedDecision.receipts);
      for (const seedBase of seeds) {
        const session = issueSession({ policy, verifierJwk: verifier.privateJwk, now, pick: () => 0, seedBase });
        store.issueSession(session.session);
        const decision = submitSession({ session: session.session, responses: answersOf(session.session), verifierJwk: verifier.privateJwk, now: later });
        store.decide(session.session.sessionId, decision.admission, decision.receipts);
      }
      store.close();
    }
    const logA = buildLog({ dir: dirA, verifierJwk: verifier.privateJwk, now: built });
    const logB = buildLog({ dir: dirB, verifierJwk: verifier.privateJwk, now: built });
    expect(findEquivocation([logA.head, logB.head])).toEqual({ ok: true, checked: 2 }); // heads cannot decide
    const report = compareLogs(logA, logB);
    expect(report).toMatchObject({ ok: false, equivocation: true, keyId: verifier.keyId, forkIndex: 2, counts: [4, 6] });
    expect(report.reason).toContain("index 2");
  });

  test("logs under different verifier keys are incomparable", () => {
    const otherLog = buildLog({ dir: makeLedger(1).dir, verifierJwk: other.privateJwk, now: built });
    const report = compareLogs(makeLog(1).log, otherLog);
    expect(report).toMatchObject({ ok: false, equivocation: false });
    expect(report.reason).toContain("different verifier keys");
  });

  test("an invalid log is incomparable, not a fork", () => {
    const { log } = makeLog(1);
    const tampered = { ...log, head: { ...log.head, count: 9 } };
    const report = compareLogs(log, tampered);
    expect(report).toMatchObject({ ok: false, equivocation: false });
    expect(report.reason).toContain("right log failed check");
  });
});

describe("tlog compare CLI", () => {
  test("exits 0 on consistent logs and 2 on a proven fork", async () => {
    const a = makeLedger(1);
    const b = makeLedger(1);
    const outA = join(a.dir, "a.json");
    const outB = join(b.dir, "b.json");
    writeFileSync(outA, JSON.stringify(buildLog({ dir: a.dir, verifierJwk: verifier.privateJwk, now: built })));
    writeFileSync(outB, JSON.stringify(buildLog({ dir: b.dir, verifierJwk: verifier.privateJwk, now: built })));

    const same = await tlog("compare", outA, outA);
    expect(same.code).toBe(0);
    expect(JSON.parse(same.stdout)).toMatchObject({ ok: true, equivocation: false, relation: "identical" });

    const fork = await tlog("compare", outA, outB);
    expect(fork.code).toBe(2);
    expect(JSON.parse(fork.stdout)).toMatchObject({ ok: false, equivocation: true, forkIndex: 0 });
  });
});

describe("tlog witness service", () => {
  test("accepts self-describing heads from many providers and reports conflicts per key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-witness-"));
    const headsPath = join(dir, "heads.jsonl");
    const witness = serveWitness({ heads: headsPath, port: 0 });
    const post = (head: unknown) => fetch(`${witness.url}/heads`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(head),
    });
    const first = signHead(2, "a".repeat(64), verifier.privateJwk, now);
    const foreign = signHead(3, "b".repeat(64), other.privateJwk, now);
    const fork = signHead(2, "c".repeat(64), verifier.privateJwk, later);
    try {
      expect(await (await fetch(`${witness.url}/healthz`)).json()).toEqual({ ok: true });
      expect(await (await post(first)).json()).toMatchObject({
        ok: true, recorded: true, keyId: verifier.keyId, witnessed: 1, providerHeads: 1, equivocation: false,
      });
      expect(await (await post({ ...first, unsignedProviderMetadata: { name: "ignored" } })).json()).toMatchObject({
        ok: true, recorded: false, keyId: verifier.keyId, witnessed: 1, providerHeads: 1, equivocation: false,
      });
      expect(await (await post(foreign)).json()).toMatchObject({
        ok: true, recorded: true, keyId: other.keyId, witnessed: 2, providerHeads: 1, equivocation: false,
      });
      expect(await (await post(fork)).json()).toMatchObject({
        ok: true, recorded: true, keyId: verifier.keyId, witnessed: 3, providerHeads: 2, equivocation: true,
      });
      expect(readHeads(headsPath)).toHaveLength(3);
      expect((readHeads(headsPath)[0] as TlogHead & { unsignedProviderMetadata?: unknown }).unsignedProviderMetadata).toBeUndefined();

      const verifierReport = await (await fetch(`${witness.url}/equivocation/${verifier.keyId}`)).json();
      expect(verifierReport).toMatchObject({ ok: false, checked: 2, keyId: verifier.keyId });
      const otherReport = await (await fetch(`${witness.url}/equivocation/${other.keyId}`)).json();
      expect(otherReport).toEqual({ ok: true, checked: 1 });

      const page1 = await (await fetch(`${witness.url}/heads?limit=2`)).json();
      expect(page1.heads).toHaveLength(2);
      expect(page1.next).toBe(2);
      const page2 = await (await fetch(`${witness.url}/heads?after=${page1.next}&limit=2`)).json();
      expect(page2.heads).toHaveLength(1);
      expect(page2.next).toBeNull();
      const filtered = await (await fetch(`${witness.url}/heads?keyId=${verifier.keyId}`)).json();
      expect(filtered.heads).toHaveLength(2);
      expect(filtered.heads.every((head: TlogHead) => head.verifier.keyId === verifier.keyId)).toBe(true);
    } finally {
      witness.close();
    }
  });

  test("bounds requests and pages and rejects unsigned or malformed heads", async () => {
    const headsPath = join(mkdtempSync(join(tmpdir(), "clankdar-witness-")), "heads.jsonl");
    const witness = serveWitness({ heads: headsPath, port: 0 });
    try {
      const invalid = await fetch(`${witness.url}/heads`, { method: "POST", body: JSON.stringify({ protocol: TLOG_PROTOCOL }) });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "not a signed tlog head" });
      const oversized = await fetch(`${witness.url}/heads`, { method: "POST", body: "x".repeat(16 * 1024 + 1) });
      expect(oversized.status).toBe(413);
      expect((await fetch(`${witness.url}/heads?limit=0`)).status).toBe(400);
      expect((await fetch(`${witness.url}/heads?after=-1`)).status).toBe(400);
      expect((await fetch(`${witness.url}/heads?after=1e2`)).status).toBe(400);
      expect((await fetch(`${witness.url}/heads?keyId=not-a-key`)).status).toBe(400);
      expect((await fetch(`${witness.url}/equivocation/not-a-key`)).status).toBe(404);
      expect((await fetch(`${witness.url}/absent`)).status).toBe(404);
      expect(await (await fetch(`${witness.url}/healthz`)).json()).toEqual({ ok: true });
    } finally {
      witness.close();
    }
  });

  test("witness-serve CLI boots the provider-neutral intake", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-witness-"));
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);
    const proc = Bun.spawn([
      Bun.which("bun")!, resolve(import.meta.dir, "tlog.ts"), "witness-serve",
      "--heads", join(dir, "heads.jsonl"), "--port", String(port),
    ], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    try {
      const reader = proc.stderr.getReader();
      let banner = "";
      while (!banner.includes("\n")) {
        const { done, value } = await reader.read();
        if (done) break;
        banner += new TextDecoder().decode(value, { stream: true });
      }
      reader.releaseLock();
      const url = /serving on (http:\/\/\S+)/.exec(banner)?.[1];
      expect(url).toBeTruthy();
      expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ ok: true });
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 15_000);
});

/** A stub hosted-style provider: `body()` is served at GET /tlog/head. */
const serveHeadProvider = (body: () => unknown) => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      if (req.method !== "GET" || new URL(req.url).pathname !== "/tlog/head") {
        return new Response("not found", { status: 404 });
      }
      const value = body();
      return typeof value === "string" ? new Response(value) : Response.json(value);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
};

/** Poll `check` until it holds, failing after `ms`. */
const waitFor = async (check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met before the deadline");
    await Bun.sleep(25);
  }
};

const statusOf = async (url: string) =>
  (await (await fetch(`${url}/status`)).json()) as {
    ok: boolean;
    pollMs?: number;
    providersFile?: string;
    providers: { url: string; lastPollAt?: string; lastResult?: string; keyId?: string }[];
  };

describe("tlog witness provider polling", () => {
  test("polls configured providers and records each head under its embedded keyId", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-witness-poll-"));
    const headsPath = join(dir, "heads.jsonl");
    const providersPath = join(dir, "providers.json");
    // Each provider re-signs on every fetch, but the committed claim stays the
    // same — the witness must dedupe by claim, not by signature.
    const providerA = serveHeadProvider(() => signHead(2, "a".repeat(64), verifier.privateJwk, new Date()));
    let bClaim = { count: 3, tip: "b".repeat(64) };
    const providerB = serveHeadProvider(() => signHead(bClaim.count, bClaim.tip, other.privateJwk, new Date()));
    writeFileSync(providersPath, JSON.stringify([{ url: providerA.url }, { url: providerB.url }]));
    const witness = serveWitness({ heads: headsPath, port: 0, providers: providersPath, pollMs: 50 });
    try {
      await waitFor(() => readHeads(headsPath).length === 2);
      const heads = readHeads(headsPath);
      expect(heads.map((head) => head.verifier.keyId).sort()).toEqual([verifier.keyId, other.keyId].sort());
      expect(heads.find((head) => head.verifier.keyId === verifier.keyId)).toMatchObject({ count: 2, head: "a".repeat(64) });

      // Per-provider poll state is observable — bounded fields, no secrets.
      const status = await statusOf(witness.url);
      expect(status).toMatchObject({ ok: true, pollMs: 50 });
      expect(status.providers).toHaveLength(2);
      const byUrl = new Map(status.providers.map((p) => [p.url, p]));
      const a = byUrl.get(new URL(providerA.url).toString());
      const b = byUrl.get(new URL(providerB.url).toString());
      expect(a).toMatchObject({ lastResult: "ok", keyId: verifier.keyId });
      expect(b).toMatchObject({ lastResult: "ok", keyId: other.keyId });
      expect(Number.isFinite(Date.parse(a!.lastPollAt!))).toBe(true);

      // Findings stay scoped per provider key across the intake.
      expect(await (await fetch(`${witness.url}/equivocation/${verifier.keyId}`)).json()).toEqual({ ok: true, checked: 1 });
      expect(await (await fetch(`${witness.url}/equivocation/${other.keyId}`)).json()).toEqual({ ok: true, checked: 1 });

      // Several more cycles pass: identical claims are not re-appended, so a
      // provider re-signing the same head cannot spam the registry.
      await Bun.sleep(200);
      expect(readHeads(headsPath)).toHaveLength(2);

      // An advanced claim is new evidence and does get recorded.
      bClaim = { count: 4, tip: "c".repeat(64) };
      await waitFor(() => readHeads(headsPath).length === 3);
      expect(readHeads(headsPath).at(-1)).toMatchObject({ count: 4, head: "c".repeat(64) });
      expect(await (await fetch(`${witness.url}/equivocation/${other.keyId}`)).json()).toEqual({ ok: true, checked: 2 });
    } finally {
      witness.close();
      providerA.close();
      providerB.close();
    }
  }, 15_000);

  test("two providers serving conflicting heads under one key surface an equivocation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-witness-poll-"));
    const headsPath = join(dir, "heads.jsonl");
    const providersPath = join(dir, "providers.json");
    // Two vantage points on the same issuer, same count, different tips — a
    // certain fork, proven entirely from the self-describing heads.
    const providerA = serveHeadProvider(() => signHead(2, "a".repeat(64), verifier.privateJwk, new Date()));
    const providerB = serveHeadProvider(() => signHead(2, "c".repeat(64), verifier.privateJwk, new Date()));
    writeFileSync(providersPath, JSON.stringify([{ url: providerA.url }, { url: providerB.url }]));
    const witness = serveWitness({ heads: headsPath, port: 0, providers: providersPath, pollMs: 50 });
    try {
      // Two conflicting claims per keyId keep arriving each cycle, so the
      // registry keeps growing — assert on the first proven fork.
      await waitFor(() => readHeads(headsPath).length >= 2);
      const report = await (await fetch(`${witness.url}/equivocation/${verifier.keyId}`)).json();
      expect(report).toMatchObject({ ok: false, keyId: verifier.keyId });
      expect(report.reason).toContain("different tips");
      expect(report.conflict).toHaveLength(2);
    } finally {
      witness.close();
      providerA.close();
      providerB.close();
    }
  }, 15_000);

  test("fetch failures, oversized bodies, and invalid heads record nothing but stay observable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-witness-poll-"));
    const headsPath = join(dir, "heads.jsonl");
    const providersPath = join(dir, "providers.json");
    const badHead = serveHeadProvider(() => ({ protocol: TLOG_PROTOCOL, kind: "head", count: -1 }));
    const oversized = serveHeadProvider(() => "x".repeat(20 * 1024));
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const deadUrl = `http://127.0.0.1:${probe.port}`;
    probe.stop(true);
    // The {providers: [...]} wrapper shape is accepted too.
    writeFileSync(providersPath, JSON.stringify({ providers: [{ url: badHead.url }, { url: oversized.url }, { url: deadUrl }] }));
    const witness = serveWitness({ heads: headsPath, port: 0, providers: providersPath, pollMs: 50 });
    try {
      await waitFor(async () => {
        const status = await statusOf(witness.url);
        return status.providers.length === 3 && status.providers.every((p) => p.lastResult !== undefined);
      });
      const status = await statusOf(witness.url);
      const byUrl = new Map(status.providers.map((p) => [p.url, p.lastResult]));
      expect(byUrl.get(new URL(badHead.url).toString())).toBe("invalid-head");
      expect(byUrl.get(new URL(oversized.url).toString())).toBe("fetch-error");
      expect(byUrl.get(new URL(deadUrl).toString())).toBe("fetch-error");
      expect(readHeads(headsPath)).toHaveLength(0);
      expect(await (await fetch(`${witness.url}/healthz`)).json()).toEqual({ ok: true });
    } finally {
      witness.close();
      badHead.close();
      oversized.close();
    }
  }, 15_000);

  test("re-reads the providers file each cycle; an invalid file skips the cycle without crashing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-witness-poll-"));
    const headsPath = join(dir, "heads.jsonl");
    const providersPath = join(dir, "providers.json");
    writeFileSync(providersPath, "not json");
    const witness = serveWitness({ heads: headsPath, port: 0, providers: providersPath, pollMs: 50 });
    const providerA = serveHeadProvider(() => signHead(2, "a".repeat(64), verifier.privateJwk, new Date()));
    const providerB = serveHeadProvider(() => signHead(5, "d".repeat(64), other.privateJwk, new Date()));
    try {
      // The bad file is flagged on the status surface; the service stays up.
      await waitFor(async () => (await statusOf(witness.url)).providersFile === "invalid");
      expect(await (await fetch(`${witness.url}/healthz`)).json()).toEqual({ ok: true });
      expect(readHeads(headsPath)).toHaveLength(0);

      // Fixing the file picks providers up without a restart.
      writeFileSync(providersPath, JSON.stringify([{ url: providerA.url }]));
      await waitFor(() => readHeads(headsPath).length === 1);
      expect((await statusOf(witness.url)).providersFile).toBeUndefined();

      // Editing it again adds a second provider on a later cycle.
      writeFileSync(providersPath, JSON.stringify([{ url: providerA.url }, { url: providerB.url }]));
      await waitFor(() => readHeads(headsPath).length === 2);

      // Removing one drops its status entry; recorded evidence stays.
      writeFileSync(providersPath, JSON.stringify([{ url: providerB.url }]));
      await waitFor(async () => (await statusOf(witness.url)).providers.length === 1);
      const status = await statusOf(witness.url);
      expect(status.providers[0].url).toBe(new URL(providerB.url).toString());
      expect(readHeads(headsPath)).toHaveLength(2);

      // Breaking the file once more flags the status without losing service.
      writeFileSync(providersPath, '{"url": 7}');
      await waitFor(async () => (await statusOf(witness.url)).providersFile === "invalid");
      expect(await (await fetch(`${witness.url}/healthz`)).json()).toEqual({ ok: true });
    } finally {
      witness.close();
      providerA.close();
      providerB.close();
    }
  }, 15_000);

  test("witness-serve --providers --poll-ms polls a hosted-style /tlog/head end to end", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-witness-poll-"));
    const headsPath = join(dir, "heads.jsonl");
    const providersPath = join(dir, "providers.json");
    const provider = serveHeadProvider(() => signHead(4, "e".repeat(64), verifier.privateJwk, new Date()));
    writeFileSync(providersPath, JSON.stringify([{ url: provider.url }]));
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);
    const proc = Bun.spawn([
      Bun.which("bun")!, resolve(import.meta.dir, "tlog.ts"), "witness-serve",
      "--heads", headsPath, "--port", String(port),
      "--providers", providersPath, "--poll-ms", "100",
    ], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    try {
      const reader = proc.stderr.getReader();
      let banner = "";
      while (!banner.includes("\n")) {
        const { done, value } = await reader.read();
        if (done) break;
        banner += new TextDecoder().decode(value, { stream: true });
      }
      reader.releaseLock();
      const url = /serving on (http:\/\/\S+)/.exec(banner)?.[1];
      expect(url).toBeTruthy();
      expect(banner).toContain("providers:");
      await waitFor(() => readHeads(headsPath).length === 1);
      expect(readHeads(headsPath)[0]).toMatchObject({ count: 4, head: "e".repeat(64) });
      const status = await statusOf(url!);
      expect(status.providers[0]).toMatchObject({ lastResult: "ok", keyId: verifier.keyId });
    } finally {
      proc.kill();
      await proc.exited;
      provider.close();
    }
  }, 15_000);
});

/** Append `count` issued-and-decided sessions to an existing ledger dir. */
const growLedger = (dir: string, count: number, seedBase = 940_000) => {
  const store = GateStore.open(dir);
  for (let i = 0; i < count; i++) {
    const issued = issueSession({ policy, verifierJwk: verifier.privateJwk, now, pick: () => 0, seedBase: seedBase + i * 100 });
    store.issueSession(issued.session);
    const { receipts, admission } = submitSession({
      session: issued.session, responses: answersOf(issued.session), verifierJwk: verifier.privateJwk, now: later,
    });
    store.decide(issued.session.sessionId, admission, receipts);
  }
  store.close();
};

describe("tlog consistency proofs", () => {
  test("a grown log verifies against its earlier pinned head", () => {
    const { dir } = makeLedger(1);
    const first = buildLog({ dir, verifierJwk: verifier.privateJwk, now });
    growLedger(dir, 2);
    const grown = buildLog({ dir, verifierJwk: verifier.privateJwk, now: built });

    const proof = proveConsistency(grown, first.head.count);
    expect(proof.protocol).toBe(CONSISTENCY_PROTOCOL);
    expect(proof).toMatchObject({ oldCount: 2, oldTip: first.head.head, newCount: 6, newTip: grown.head.head });
    expect(proof.suffix).toEqual(grown.entries.slice(2));
    expect(proof.suffix[0].prev).toBe(first.head.head); // the linkage boundary
    expect(proof.head).toEqual(grown.head);

    // A witnessed signed head and a bare count+tip pin both verify.
    expect(checkConsistency(proof, { pinnedHead: first.head }))
      .toEqual({ ok: true, oldCount: 2, newCount: 6, newTip: grown.head.head, keyId: verifier.keyId });
    expect(checkConsistency(proof, { pinnedTip: { count: 2, tip: first.head.head } })).toMatchObject({ ok: true });
  });

  test("genesis proofs self-authenticate; an empty suffix proves a same-tip head", () => {
    const { log } = makeLog(2);
    const genesis = proveConsistency(log, 0);
    expect(genesis.oldTip).toBe("0".repeat(64));
    expect(genesis.suffix).toHaveLength(4); // the whole log — the full-replay degenerate case
    expect(checkConsistency(genesis)).toMatchObject({ ok: true, oldCount: 0, newCount: 4 });
    expect(checkConsistency(genesis, { pinnedTip: { count: 0, tip: "0".repeat(64) } })).toMatchObject({ ok: true });
    const genesisHead = signHead(0, "0".repeat(64), verifier.privateJwk, now);
    expect(checkConsistency(genesis, { pinnedHead: genesisHead })).toMatchObject({ ok: true });

    // oldCount == newCount — nothing grew — is valid only while the tip is unchanged.
    const still = proveConsistency(log, log.entries.length);
    expect(still.suffix).toHaveLength(0);
    expect(still.oldTip).toBe(log.head.head);
    expect(checkConsistency(still, { pinnedHead: log.head })).toMatchObject({ ok: true, oldCount: 4, newCount: 4 });
    const drifted = checkConsistency({ ...still, newTip: "e".repeat(64) }, { pinnedHead: log.head });
    expect(drifted.ok).toBe(false);
    expect(drifted.reason).toContain("does not recompute");
  });

  test("proveConsistency rejects out-of-range counts and logs that fail check", () => {
    const { log } = makeLog(1);
    expect(() => proveConsistency(log, -1)).toThrow("integer in 0..2");
    expect(() => proveConsistency(log, 3)).toThrow("integer in 0..2");
    expect(() => proveConsistency(log, 1.5)).toThrow("integer in 0..2");
    const tampered = { ...log, head: { ...log.head, count: 9 } };
    expect(() => proveConsistency(tampered, 0)).toThrow("failed check");
    // A proof whose counts regress is malformed before any pin is consulted.
    expect(checkConsistency({ ...proveConsistency(log, 0), oldCount: 9 }).reason).toContain("exceeds newCount");
    expect(checkConsistency("nope", { pinnedHead: log.head }).reason).toContain("not a consistency proof");
    expect(checkConsistency({ ...proveConsistency(log, 0), newCount: -1 }).reason).toContain("newCount is not");
  });

  test("tampering at the boundary, in the suffix, or in the head fails with a reason", () => {
    const { dir } = makeLedger(1);
    const first = buildLog({ dir, verifierJwk: verifier.privateJwk, now });
    growLedger(dir, 1);
    const grown = buildLog({ dir, verifierJwk: verifier.privateJwk, now: built });
    const proof = proveConsistency(grown, 2);
    const pinned = { pinnedHead: first.head };

    const cases: [ConsistencyProof, string][] = [
      // The prover cannot move the boundary — oldTip must equal the pin.
      [{ ...proof, oldTip: "f".repeat(64) }, "does not match the pinned tip"],
      // The linkage boundary: suffix[0].prev must BE the pinned tip.
      [{ ...proof, suffix: proof.suffix.map((e, i) => (i === 0 ? { ...e, prev: "f".repeat(64) } : e)) }, "does not extend the pinned tip"],
      // Suffix body tampered — the hash no longer recomputes.
      [{ ...proof, suffix: proof.suffix.map((e, i) => (i === 1 ? { ...e, digest: "f".repeat(64) } : e)) }, "hash does not recompute"],
      // An index shift breaks the position commitment.
      [{ ...proof, suffix: proof.suffix.map((e, i) => (i === 0 ? { ...e, index: 9 } : e)) }, "wrong index"],
      // A dropped suffix entry breaks the count delta.
      [{ ...proof, suffix: proof.suffix.slice(1) }, "count delta"],
      // The claimed new tip is not what the suffix recomputes to.
      [{ ...proof, newTip: "b".repeat(64) }, "does not recompute to the new tip"],
      // Freshly signed heads committing different claims are still rejected.
      [{ ...proof, head: signHead(99, proof.newTip, verifier.privateJwk, now) }, "count does not match newCount"],
      [{ ...proof, head: signHead(proof.newCount, "b".repeat(64), verifier.privateJwk, now) }, "does not commit to the new tip"],
      [{ ...proof, head: { ...proof.head, signature: "AAAA" } }, "not a valid signed head"],
      [{ ...proof, protocol: "clankdar-tlog-consistency-v0" as typeof CONSISTENCY_PROTOCOL }, "not a clankdar-tlog-consistency-v1 proof"],
    ];
    for (const [forged, reason] of cases) {
      const result = checkConsistency(forged, pinned);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain(reason);
    }
  });

  test("the pin is the trust root — absent, mismatched, or foreign pins fail", () => {
    const { dir } = makeLedger(1);
    const first = buildLog({ dir, verifierJwk: verifier.privateJwk, now });
    growLedger(dir, 1);
    const grown = buildLog({ dir, verifierJwk: verifier.privateJwk, now: built });
    const proof = proveConsistency(grown, 2);

    // A nonzero boundary with no pin fails closed.
    expect(checkConsistency(proof).reason).toContain("no pinned old head");
    // A pin at the wrong count or tip cannot slide the boundary.
    expect(checkConsistency(proof, { pinnedTip: { count: 1, tip: first.head.head } }).reason).toContain("does not match proof oldCount");
    expect(checkConsistency(proof, { pinnedTip: { count: 2, tip: "b".repeat(64) } }).reason).toContain("does not match the pinned tip");
    expect(checkConsistency(proof, { pinnedTip: { count: 2, tip: "zz" } }).reason).toContain("pinned tip is malformed");
    // An unsigned head file is not a pin, and both pin forms at once are ambiguous.
    expect(checkConsistency(proof, { pinnedHead: { ...first.head, signature: "AAAA" } }).reason).toContain("not a valid signed head");
    expect(checkConsistency(proof, { pinnedHead: first.head, pinnedTip: { count: 2, tip: first.head.head } }).reason).toContain("not both");
    // A forked log's own boundary never matches the pin — same count, its own tip.
    const fork = makeLog(2).log; // same verifier, unrelated ledger, also 4 entries
    expect(checkConsistency(proveConsistency(fork, 2), { pinnedHead: first.head }).reason).toContain("does not match the pinned tip");
    // A head signed by a DIFFERENT key over the real tip is not this issuer's pin.
    const alienPin = signHead(2, proof.oldTip, other.privateJwk, now);
    expect(checkConsistency(proof, { pinnedHead: alienPin }).reason).toContain("different verifier key");
  });
});

describe("tlog consistency CLI", () => {
  test("prove --from-count → check-proof round-trips against a pinned head file", async () => {
    const { dir } = makeLedger(1);
    const keyFile = join(dir, "verifier.json");
    const logA = join(dir, "tlog-a.json");
    const headFile = join(dir, "head.json");
    writeFileSync(keyFile, JSON.stringify(verifier.privateJwk));
    expect((await tlog("build", "--dir", dir, "--key", keyFile, "--out", logA)).code).toBe(0);
    const headA = (JSON.parse(readFileSync(logA, "utf8")) as TransparencyLog).head;
    writeFileSync(headFile, JSON.stringify(headA));

    growLedger(dir, 1);
    const logB = join(dir, "tlog-b.json");
    expect((await tlog("build", "--dir", dir, "--key", keyFile, "--out", logB)).code).toBe(0);

    const proved = await tlog("prove", logB, "--from-count", "2");
    expect(proved.code).toBe(0);
    const proofFile = join(dir, "consistency.json");
    writeFileSync(proofFile, proved.stdout);
    const proof = JSON.parse(proved.stdout) as ConsistencyProof;
    expect(proof).toMatchObject({ protocol: CONSISTENCY_PROTOCOL, oldCount: 2, oldTip: headA.head, newCount: 4 });
    expect(proof.suffix).toHaveLength(2);

    const viaHead = await tlog("check-proof", proofFile, "--old-head", headFile);
    expect(viaHead.code).toBe(0);
    expect(JSON.parse(viaHead.stdout)).toMatchObject({ ok: true, oldCount: 2, newCount: 4, keyId: verifier.keyId });
    const viaTip = await tlog("check-proof", proofFile, "--old-count", "2", "--old-tip", headA.head);
    expect(viaTip.code).toBe(0);
    expect(JSON.parse(viaTip.stdout).ok).toBe(true);

    // A nonzero boundary with no pin fails closed; genesis self-authenticates.
    const unpinned = await tlog("check-proof", proofFile);
    expect(unpinned.code).toBe(2);
    expect(JSON.parse(unpinned.stdout).reason).toContain("no pinned old head");
    const genesisFile = join(dir, "genesis.json");
    const genesis = await tlog("prove", logB, "--from-count", "0");
    expect(genesis.code).toBe(0);
    writeFileSync(genesisFile, genesis.stdout);
    expect((await tlog("check-proof", genesisFile)).code).toBe(0);

    // A mismatched head file and a tampered boundary both exit 2.
    const wrongHead = join(dir, "wrong-head.json");
    writeFileSync(wrongHead, JSON.stringify(signHead(2, "b".repeat(64), verifier.privateJwk, now)));
    expect((await tlog("check-proof", proofFile, "--old-head", wrongHead)).code).toBe(2);
    const tamperedFile = join(dir, "consistency-tampered.json");
    writeFileSync(tamperedFile, JSON.stringify({
      ...proof, suffix: proof.suffix.map((e, i) => (i === 0 ? { ...e, prev: "f".repeat(64) } : e)),
    }));
    const bad = await tlog("check-proof", tamperedFile, "--old-head", headFile);
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.stdout).reason).toContain("does not extend the pinned tip");

    // Flag misuse is a usage error, not a verdict.
    expect((await tlog("prove", logB, "--session", "gs_x", "--from-count", "2")).code).toBe(2);
    expect((await tlog("prove", logB, "--from-count", "99")).code).toBe(2);
    expect((await tlog("check-proof", proofFile, "--old-tip", headA.head)).code).toBe(2);
  });
});
