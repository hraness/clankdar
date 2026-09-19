import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonical, generateVerifier, publicKeyOf, signBody, subjectProofFor, type VerifierJwk } from "./attest.ts";
import { issueSession, submitSession, type Admission, type GatePolicy, type GateSession } from "./gate.ts";
import { generatePool, type HoldoutPool } from "./holdout.ts";
import { GateStore } from "./store.ts";
import { buildLog, proveSession } from "./tlog.ts";
import { BADGE_PROTOCOL, checkBadge, packBadge, type Badge, type BadgeBody, type BadgeProof } from "./badge.ts";

const verifier = generateVerifier();
const other = generateVerifier();
const subject = generateVerifier();
const stranger = generateVerifier();
const policy: GatePolicy = { suite: "v2", cells: ["arithmetic:t0", "arithmetic:t1"], challenges: 2, minPass: 1, ttlSeconds: 300 };
const now = new Date("2026-09-18T00:00:00Z");
const later = new Date("2026-09-18T00:01:00Z");
const built = new Date("2026-09-18T00:02:00Z");

const answersOf = (session: GateSession) =>
  Object.fromEntries(session.tickets.map((t) => [t.challenge.challengeId, t.expected]));

/** A real admission bound to a subject key: session + submit carrying a session-scoped proof. */
const boundAdmission = (opts: { verifierJwk?: VerifierJwk; subjectJwk?: VerifierJwk; seedBase?: number } = {}) => {
  const verifierJwk = opts.verifierJwk ?? verifier.privateJwk;
  const subjectJwk = opts.subjectJwk ?? subject.privateJwk;
  const issued = issueSession({ policy, verifierJwk, now, pick: () => 0, seedBase: opts.seedBase ?? 700_000 });
  const subjectProof = subjectProofFor(issued.session.tickets[0].challenge, subjectJwk);
  const { admission } = submitSession({ session: issued.session, responses: answersOf(issued.session), subjectProof, verifierJwk, now: later });
  return { issued, admission };
};

const heldoutBoundAdmission = (opts: { verifierJwk?: VerifierJwk; seedBase?: number } = {}): { admission: Admission; pool: HoldoutPool } => {
  const verifierJwk = opts.verifierJwk ?? verifier.privateJwk;
  const pool = generatePool({ suite: "v2", cells: ["arithmetic:t0"] });
  const heldoutPolicy: GatePolicy = { suite: "v2", cells: ["h:arithmetic:t0"], challenges: 2, minPass: 1, ttlSeconds: 300 };
  const issued = issueSession({ policy: heldoutPolicy, verifierJwk, pool, now, pick: () => 0, seedBase: opts.seedBase ?? 700_000 });
  const subjectProof = subjectProofFor(issued.session.tickets[0].challenge, subject.privateJwk);
  const { admission } = submitSession({
    session: issued.session, responses: answersOf(issued.session), subjectProof, verifierJwk, pool, now: later,
  });
  return { admission, pool };
};

/** A real admission with no subject proof — valid, but not badge material. */
const unboundAdmission = () => {
  const issued = issueSession({ policy, verifierJwk: verifier.privateJwk, now, pick: () => 0, seedBase: 700_000 });
  const { admission } = submitSession({ session: issued.session, responses: answersOf(issued.session), verifierJwk: verifier.privateJwk, now: later });
  return admission;
};

/** A subject-bound admission whose session (and decision) also lives in a real ledger → log → proof. */
const loggedAdmission = (seedBase: number, opts: { decide?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "clankdar-badge-"));
  const store = GateStore.open(dir);
  const issued = issueSession({ policy, verifierJwk: verifier.privateJwk, now, pick: () => 0, seedBase });
  store.issueSession(issued.session);
  const subjectProof = subjectProofFor(issued.session.tickets[0].challenge, subject.privateJwk);
  const { receipts, admission } = submitSession({
    session: issued.session, responses: answersOf(issued.session), subjectProof, verifierJwk: verifier.privateJwk, now: later,
  });
  if (opts.decide !== false) store.decide(issued.session.sessionId, admission, receipts);
  store.close();
  const log = buildLog({ dir, verifierJwk: verifier.privateJwk, now: built });
  const proof: BadgeProof = { log, proof: proveSession(log, issued.session.sessionId) };
  return { issued, admission, proof };
};

/** Sign a badge body directly — the crafting path for checker rejection tests. */
const badgeOf = (body: Partial<BadgeBody> & Pick<BadgeBody, "admissions">, subjectJwk: VerifierJwk = subject.privateJwk): Badge => {
  const full: BadgeBody = { kind: "badge", subjectKey: publicKeyOf(subjectJwk), issuedAt: later.toISOString(), ...body };
  return { protocol: BADGE_PROTOCOL, payload: canonical(full), signature: signBody(full, subjectJwk) };
};

async function badge(...args: string[]) {
  const proc = Bun.spawn([Bun.which("bun")!, resolve(import.meta.dir, "badge.ts"), ...args], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, stdout, stderr };
}

describe("badge pack and check", () => {
  test("pack → check roundtrip over subject-bound admissions", () => {
    const a = boundAdmission();
    const b = boundAdmission({ seedBase: 800_000 });
    const badge = packBadge({ admissions: [a.admission, b.admission], subjectJwk: subject.privateJwk, now: built });
    expect(badge.protocol).toBe(BADGE_PROTOCOL);
    const body = JSON.parse(badge.payload) as BadgeBody;
    expect(body.kind).toBe("badge");
    expect(body.subjectKey).toBe(subject.publicKey);
    expect(body.admissions).toHaveLength(2);
    expect(checkBadge(badge)).toEqual({ ok: true, subject: subject.publicKey, admissions: 2, passed: 2, logged: 0 });
  });

  test("admissions from different verifier keys aggregate under one subject", () => {
    // The product case: one subject key, two independent issuers.
    const a = boundAdmission({ verifierJwk: verifier.privateJwk });
    const b = boundAdmission({ verifierJwk: other.privateJwk, seedBase: 800_000 });
    const badge = packBadge({ admissions: [a.admission, b.admission], subjectJwk: subject.privateJwk, now: built });
    expect(checkBadge(badge)).toEqual({ ok: true, subject: subject.publicKey, admissions: 2, passed: 2, logged: 0 });
  });

  test("held-out scores stay visible across many issuer pools until each pool is disclosed", () => {
    const a = heldoutBoundAdmission();
    const b = heldoutBoundAdmission({ verifierJwk: other.privateJwk, seedBase: 800_000 });
    const badge = packBadge({ admissions: [a.admission, b.admission], subjectJwk: subject.privateJwk, now: built });
    expect(checkBadge(badge)).toEqual({
      ok: true, subject: subject.publicKey, admissions: 2, passed: 2, logged: 0, unreplayed: 4,
    });
    expect(checkBadge(badge, { pools: [a.pool] })).toEqual({
      ok: true, subject: subject.publicKey, admissions: 2, passed: 2, logged: 0, unreplayed: 2,
    });
    expect(checkBadge(badge, { pools: [a.pool, b.pool] })).toEqual({
      ok: true, subject: subject.publicKey, admissions: 2, passed: 2, logged: 0,
    });
    expect(packBadge({
      admissions: [a.admission, b.admission], pools: [a.pool, b.pool], subjectJwk: subject.privateJwk, now: built,
    }).protocol).toBe(BADGE_PROTOCOL);
  });

  test("badge checking rejects duplicate or invalid disclosed pools", () => {
    const a = heldoutBoundAdmission();
    const badge = packBadge({ admissions: [a.admission], subjectJwk: subject.privateJwk, now: built });
    expect(checkBadge(badge, { pools: [a.pool, a.pool] }).reason).toContain("share a poolKey");
    const tampered = { ...a.pool, cells: a.pool.cells.map((cell, index) => index ? cell : { ...cell, label: `${cell.label}x` }) };
    expect(checkBadge(badge, { pools: [tampered] }).reason).toContain("pool does not verify");
  });

  test("a badge can carry a failing verdict — it reports, it does not certify", () => {
    const strict: GatePolicy = { ...policy, minPass: 2 };
    const issued = issueSession({ policy: strict, verifierJwk: verifier.privateJwk, now, pick: () => 0, seedBase: 700_000 });
    const subjectProof = subjectProofFor(issued.session.tickets[0].challenge, subject.privateJwk);
    const [first] = issued.session.tickets;
    const { admission } = submitSession({
      session: issued.session, responses: { [first.challenge.challengeId]: first.expected },
      subjectProof, verifierJwk: verifier.privateJwk, now: later,
    });
    const badge = packBadge({ admissions: [admission], subjectJwk: subject.privateJwk, now: built });
    expect(checkBadge(badge)).toEqual({ ok: true, subject: subject.publicKey, admissions: 1, passed: 0, logged: 0 });
  });

  test("pack refuses admissions that cannot form a valid badge", () => {
    const foreign = boundAdmission({ subjectJwk: stranger.privateJwk });
    expect(() => packBadge({ admissions: [foreign.admission], subjectJwk: subject.privateJwk })).toThrow("different subject");
    expect(() => packBadge({ admissions: [unboundAdmission()], subjectJwk: subject.privateJwk })).toThrow("not subject-bound");
    expect(() => packBadge({ admissions: [], subjectJwk: subject.privateJwk })).toThrow("1..64");
  });
});

describe("badge checking", () => {
  test("rejects an admission bound to a different subject", () => {
    const foreign = boundAdmission({ subjectJwk: stranger.privateJwk });
    const badge = badgeOf({ admissions: [foreign.admission] });
    const result = checkBadge(badge);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("different subject");
  });

  test("rejects an admission carrying no subject proof", () => {
    const badge = badgeOf({ admissions: [unboundAdmission()] });
    const result = checkBadge(badge);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not subject-bound");
  });

  test("rejects malformed admission members without throwing", () => {
    for (const admission of [null, "not-an-admission", { payload: 7 }]) {
      const badge = badgeOf({ admissions: [admission as unknown as Admission] });
      expect(checkBadge(badge)).toMatchObject({ ok: false, reason: "admission does not verify: not a gate admission" });
    }
  });

  test("rejects two admissions sharing one session", () => {
    const { admission } = boundAdmission();
    const badge = badgeOf({ admissions: [admission, admission] });
    const result = checkBadge(badge);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("share a session");
  });

  test("rejects more than 64 admissions; 64 pass", () => {
    const many = Array.from({ length: 64 }, (_, i) => boundAdmission({ seedBase: 700_000 + i * 100 }).admission);
    expect(checkBadge(badgeOf({ admissions: many }))).toMatchObject({ ok: true, admissions: 64 });
    const over = [...many, boundAdmission({ seedBase: 999_000 }).admission];
    const result = checkBadge(badgeOf({ admissions: over }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("1..64");
  });

  test("rejects tampering at every layer", () => {
    const badge = packBadge({ admissions: [boundAdmission().admission], subjectJwk: subject.privateJwk, now: built });
    const body = JSON.parse(badge.payload) as BadgeBody;
    const cases: Badge[] = [
      { ...badge, signature: badge.signature.slice(0, -4) + "AAAA" },
      { ...badge, payload: JSON.stringify({ ...body, kind: "receipt" }) },
      { ...badge, payload: JSON.stringify({ ...body, subjectKey: stranger.publicKey }) },
      { ...badge, payload: JSON.stringify({ ...body, issuedAt: "not-a-date" }) },
      { ...badge, payload: "not json" },
      { protocol: BADGE_PROTOCOL, payload: "{}", signature: "x" },
      { ...badge, protocol: "clankdar-badge-v0" as typeof BADGE_PROTOCOL },
    ];
    for (const tampered of cases) expect(checkBadge(tampered).ok).toBe(false);
  });

  test("a badge re-signed under a foreign key fails", () => {
    const { admission } = boundAdmission();
    const body: BadgeBody = { kind: "badge", subjectKey: subject.publicKey, admissions: [admission], issuedAt: later.toISOString() };
    const forged: Badge = { protocol: BADGE_PROTOCOL, payload: canonical(body), signature: signBody(body, verifier.privateJwk) };
    expect(checkBadge(forged).ok).toBe(false);
  });
});

describe("badge tlog proofs", () => {
  test("verified inclusion proofs mark admissions as logged", () => {
    const a = loggedAdmission(700_000);
    const b = loggedAdmission(800_000);
    const unlogged = boundAdmission({ seedBase: 900_000 });
    const badge = packBadge({
      admissions: [a.admission, b.admission, unlogged.admission],
      proofs: [a.proof, b.proof],
      subjectJwk: subject.privateJwk, now: built,
    });
    expect(checkBadge(badge)).toEqual({ ok: true, subject: subject.publicKey, admissions: 3, passed: 3, logged: 2 });
  });

  test("a tampered proof alongside a valid one fails the badge", () => {
    const a = loggedAdmission(700_000);
    const b = loggedAdmission(800_000);
    const tampered: BadgeProof = { log: b.proof.log, proof: { ...b.proof.proof, sessionIndex: b.proof.proof.sessionIndex + 1 } };
    const badge = badgeOf({ admissions: [a.admission, b.admission], proofs: [a.proof, tampered] });
    const result = checkBadge(badge);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not match the log");
  });

  test("a proof against a corrupted log fails the badge", () => {
    const a = loggedAdmission(700_000);
    const corrupted: BadgeProof = { log: { ...a.proof.log, head: { ...a.proof.log.head, count: 99 } }, proof: a.proof.proof };
    const badge = badgeOf({ admissions: [a.admission], proofs: [corrupted] });
    const result = checkBadge(badge);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not verify");
  });

  test("a proof naming a session the badge does not carry fails", () => {
    const a = loggedAdmission(700_000);
    const carried = boundAdmission({ seedBase: 800_000 });
    // A real proof — but for a session absent from this badge.
    const badge = badgeOf({ admissions: [carried.admission], proofs: [a.proof] });
    const result = checkBadge(badge);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not carry");
  });

  test("a proof with no logged decision fails — issued is not decided", () => {
    const a = loggedAdmission(700_000, { decide: false });
    expect(a.proof.proof.decisionIndex).toBeNull();
    const badge = badgeOf({ admissions: [a.admission], proofs: [a.proof] });
    const result = checkBadge(badge);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no logged decision");
  });
});

describe("badge CLI", () => {
  test("pack → check round-trip through files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-badge-"));
    const a = loggedAdmission(700_000);
    const b = boundAdmission({ verifierJwk: other.privateJwk, seedBase: 800_000 });
    const keyFile = join(dir, "subject.json");
    const badgeFile = join(dir, "badge.json");
    writeFileSync(keyFile, JSON.stringify(subject.privateJwk));
    writeFileSync(join(dir, "a.json"), JSON.stringify(a.admission));
    writeFileSync(join(dir, "b.json"), JSON.stringify(b.admission));
    writeFileSync(join(dir, "proofs.json"), JSON.stringify([a.proof]));

    const packed = await badge("pack", "--subject-key", keyFile, "--admissions", `${join(dir, "a.json")},${join(dir, "b.json")}`, "--proofs", join(dir, "proofs.json"), "--out", badgeFile);
    expect(packed.code).toBe(0);
    const written = JSON.parse(readFileSync(badgeFile, "utf8")) as Badge;
    expect(written.protocol).toBe(BADGE_PROTOCOL);

    const checked = await badge("check", badgeFile);
    expect(checked.code).toBe(0);
    expect(JSON.parse(checked.stdout)).toEqual({ ok: true, subject: subject.publicKey, admissions: 2, verdicts: { pass: 2 }, logged: 1 });

    expect((await badge("pack", "--subject-key", keyFile, "--admissions", join(dir, "a.json"), "--out", badgeFile)).code).not.toBe(0); // never overwrites

    writeFileSync(join(dir, "tampered.json"), JSON.stringify({ ...written, signature: "AAAA" }));
    const bad = await badge("check", join(dir, "tampered.json"));
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.stdout).ok).toBe(false);
  });

  test("check accepts many disclosed pools and reports undisclosed scores", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-badge-holdout-"));
    const a = heldoutBoundAdmission();
    const b = heldoutBoundAdmission({ verifierJwk: other.privateJwk, seedBase: 800_000 });
    const keyFile = join(dir, "subject.json");
    const badgeFile = join(dir, "badge.json");
    const admissionA = join(dir, "a.json");
    const admissionB = join(dir, "b.json");
    const poolA = join(dir, "pool-a.json");
    const poolB = join(dir, "pool-b.json");
    writeFileSync(keyFile, JSON.stringify(subject.privateJwk));
    writeFileSync(admissionA, JSON.stringify(a.admission));
    writeFileSync(admissionB, JSON.stringify(b.admission));
    writeFileSync(poolA, JSON.stringify(a.pool));
    writeFileSync(poolB, JSON.stringify(b.pool));
    expect((await badge(
      "pack", "--subject-key", keyFile, "--admissions", `${admissionA},${admissionB}`, "--out", badgeFile,
    )).code).toBe(0);

    const claimed = await badge("check", badgeFile);
    expect(JSON.parse(claimed.stdout)).toMatchObject({ ok: true, unreplayed: 4 });
    const replayed = await badge("check", badgeFile, "--pools", `${poolA},${poolB}`);
    expect(JSON.parse(replayed.stdout)).toEqual({
      ok: true, subject: subject.publicKey, admissions: 2, verdicts: { pass: 2 }, logged: 0,
    });
  });

  test("pack exits nonzero on an unbound admission", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-badge-"));
    const keyFile = join(dir, "subject.json");
    const admissionFile = join(dir, "unbound.json");
    writeFileSync(keyFile, JSON.stringify(subject.privateJwk));
    writeFileSync(admissionFile, JSON.stringify(unboundAdmission()));
    const packed = await badge("pack", "--subject-key", keyFile, "--admissions", admissionFile);
    expect(packed.code).toBe(2);
    expect(packed.stderr).toContain("not subject-bound");
  });
});
