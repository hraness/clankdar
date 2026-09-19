import { describe, expect, test } from "bun:test";
import { canonical, checkReceipt, generateVerifier, issueChallenge, seedCommit, signBody, verifyResponse, type Challenge, type Receipt, type ReceiptBody } from "./attest.ts";
import { checkAdmission, issueSession, parsePolicy, submitSession, type GatePolicy } from "./gate.ts";
import { generatePool, holdoutCell, holdoutInstance, parsePool, poolKeyOf, HOLDOUT_PROTOCOL, type HoldoutPool } from "./holdout.ts";
import { poolForVersion, suiteVersion } from "../ladder/mod.ts";
import { mixSeed } from "../ladder/rng.ts";

const verifier = generateVerifier();
const now = new Date("2026-09-18T00:00:00Z");
const later = new Date("2026-09-18T00:01:00Z");

const pool = generatePool({ suite: "frontier", cells: ["sat:t4", "knights:t5"] });
const otherPool = generatePool({ suite: "frontier", cells: ["knights:t5"] });

const holdoutTicket = (over: Partial<Parameters<typeof issueChallenge>[0]> = {}) =>
  issueChallenge({
    suite: "frontier", family: "sat", tier: 4, seed: 12345, ttlSeconds: 300,
    holdoutPool: pool, verifierJwk: verifier.privateJwk, now, ...over,
  });

describe("holdout pools", () => {
  test("gen mints a committed, parseable pool with secret labels", () => {
    const parsed = parsePool(JSON.parse(JSON.stringify(pool)));
    expect(parsed.poolKey).toBe(pool.poolKey);
    expect(parsed.poolKey).toBe(poolKeyOf("frontier", parsed.cells));
    expect(parsed.cells).toHaveLength(2);
    for (const cell of parsed.cells) expect(cell.label).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
  });

  test("parsePool rejects tampering, unknown cells, and bad commitments", () => {
    const raw = JSON.parse(JSON.stringify(pool));
    expect(() => parsePool({ ...raw, protocol: "other" })).toThrow("invalid holdout pool");
    expect(() => parsePool({ ...raw, suite: "v2" })).toThrow("invalid holdout pool");
    expect(() => parsePool({ ...raw, poolKey: "0".repeat(64) })).toThrow("invalid holdout pool");
    const tampered = { ...raw, cells: raw.cells.map((c: { label: string }) => ({ ...c, label: c.label.replace(/^./, "Z") })) };
    expect(() => parsePool(tampered)).toThrow("invalid holdout pool");
    expect(() => parsePool({ ...raw, cells: [{ family: "sat", tier: 4, label: "short" }] })).toThrow("invalid holdout pool");
    expect(() => parsePool({ ...raw, cells: [{ family: "nosuch", tier: 0, label: pool.cells[0].label }] })).toThrow("invalid holdout pool");
  });

  test("the label re-parameterizes the stream: same seed, different instance", () => {
    const cell = holdoutCell(pool, "sat", 4)!;
    const held = holdoutInstance(pool, cell, 777);
    const published = poolForVersion(suiteVersion("frontier")).find((f) => f.name === "sat")!.generate(4, 777);
    expect(held.seed).toBe(777);
    expect(held.prompt).not.toBe(published.prompt);
    // and it regenerates exactly from label+seed
    const again = poolForVersion(suiteVersion("frontier")).find((f) => f.name === "sat")!.generate(4, mixSeed(cell.label, 777));
    expect(held.prompt).toBe(again.prompt);
    expect(held.answer).toBe(again.answer);
  });
});

describe("held-out challenges", () => {
  test("issue marks the challenge and the ticket verifies only with the pool", () => {
    const { challenge, ticket } = holdoutTicket();
    expect(challenge.heldout).toEqual({ poolKey: pool.poolKey });
    const receipt = verifyResponse({ ticket, response: ticket.expected, pool, verifierJwk: verifier.privateJwk, now: later });
    expect(checkReceipt(receipt, { pool })).toEqual({ ok: true, verdict: true });
    expect(() => verifyResponse({ ticket, response: ticket.expected, verifierJwk: verifier.privateJwk, now: later })).toThrow("holdout pool");
  });

  test("a held-out receipt is ok-but-unreplayable without its pool", () => {
    const { ticket } = holdoutTicket();
    const receipt = verifyResponse({ ticket, response: ticket.expected, pool, verifierJwk: verifier.privateJwk, now: later });
    expect(checkReceipt(receipt)).toEqual({ ok: true, verdict: true, replayable: false });
    expect(checkReceipt(receipt, { pool: otherPool })).toEqual({ ok: true, verdict: true, replayable: false });
    expect(checkReceipt(receipt, { pool })).toEqual({ ok: true, verdict: true });
  });

  test("a challenge claiming a cell outside the committed pool fails for pool holders", () => {
    const { ticket } = holdoutTicket();
    const receipt = verifyResponse({ ticket, response: ticket.expected, pool, verifierJwk: verifier.privateJwk, now: later });
    const body = JSON.parse(receipt.payload) as ReceiptBody;
    // fabricate: same committed pool, a family the pool does not carry —
    // a cheating issuer recomputes a well-formed seedCommit over the lie
    const lie = { ...body.challenge, family: "bitmatrix", tier: 4 } as Challenge;
    lie.seedCommit = seedCommit(lie, body.seed);
    const forged: ReceiptBody = { ...body, challenge: lie };
    const fake: Receipt = { protocol: receipt.protocol, payload: canonical(forged), signature: signBody(forged, verifier.privateJwk) };
    expect(checkReceipt(fake, { pool })).toEqual({ ok: false, reason: "held-out cell is not in the committed pool" });
    // a pool-less checker cannot adjudicate — the envelope still verifies
    expect(checkReceipt(fake)).toEqual({ ok: true, verdict: true, replayable: false });
  });

  test("issuance refuses cells missing from the pool or the wrong suite", () => {
    expect(() => holdoutTicket({ family: "bitmatrix", tier: 4 })).toThrow("not in the holdout pool");
    expect(() => holdoutTicket({ holdoutPool: otherPool })).toThrow("not in the holdout pool");
    const v2Pool = generatePool({ suite: "v2", cells: ["arithmetic:t1"] });
    expect(() => holdoutTicket({ holdoutPool: v2Pool })).toThrow("different suite");
  });
});

describe("held-out gate sessions", () => {
  const hPolicy: GatePolicy = { suite: "frontier", cells: ["h:sat:t4", "sat:t4"], challenges: 3, minPass: 2, ttlSeconds: 300 };

  test("policy validates h: cells against the pool and parses without one", () => {
    expect(parsePolicy(hPolicy, { pool })).toEqual(hPolicy);
    expect(parsePolicy(hPolicy)).toEqual(hPolicy); // checker path: syntax only
    expect(() => parsePolicy(hPolicy, { pool: otherPool })).toThrow("invalid gate policy");
    expect(() => parsePolicy({ ...hPolicy, cells: ["h:nosuch:t9"] }, { pool })).toThrow("invalid gate policy");
    expect(() => parsePolicy({ ...hPolicy, cells: ["h:sat:t4"] }, { pool: generatePool({ suite: "v2", cells: ["arithmetic:t1"] }) })).toThrow("invalid gate policy");
  });

  test("held-out sessions replay with the pool and report unreplayed without it", () => {
    const issued = issueSession({ policy: hPolicy, verifierJwk: verifier.privateJwk, pool, pick: () => 0, seedBase: 42_000, now });
    expect(issued.challenges.every((c) => c.heldout?.poolKey === pool.poolKey)).toBe(true);
    const responses = Object.fromEntries(issued.session.tickets.map((t) => [t.challenge.challengeId, t.expected]));
    const { admission } = submitSession({ session: issued.session, responses, pool, verifierJwk: verifier.privateJwk, now: later });
    expect(checkAdmission(admission, { pool })).toEqual({ ok: true, verdict: true, passed: 3 });
    expect(checkAdmission(admission)).toEqual({ ok: true, verdict: true, passed: 3, unreplayed: 3 });
  });

  test("mixed published and held-out cells each replay their own stream", () => {
    const issued = issueSession({ policy: hPolicy, verifierJwk: verifier.privateJwk, pool, pick: (n) => n - 1, seedBase: 42_000, now });
    // pick last cell => published sat:t4 — no heldout marker
    expect(issued.challenges.every((c) => c.heldout === undefined)).toBe(true);
    const responses = Object.fromEntries(issued.session.tickets.map((t) => [t.challenge.challengeId, t.expected]));
    const { admission } = submitSession({ session: issued.session, responses, pool, verifierJwk: verifier.privateJwk, now: later });
    expect(checkAdmission(admission, { pool })).toEqual({ ok: true, verdict: true, passed: 3 });
    expect(checkAdmission(admission)).toEqual({ ok: true, verdict: true, passed: 3 });
  });

  test("issuing a held-out policy without the pool refuses", () => {
    expect(() => issueSession({ policy: hPolicy, verifierJwk: verifier.privateJwk, now })).toThrow("holdout pool");
  });

  test("marker/cell mismatches and mixed pools are rejected", () => {
    const issued = issueSession({ policy: hPolicy, verifierJwk: verifier.privateJwk, pool, pick: () => 0, seedBase: 42_000, now });
    const responses = Object.fromEntries(issued.session.tickets.map((t) => [t.challenge.challengeId, t.expected]));
    const { admission } = submitSession({ session: issued.session, responses, pool, verifierJwk: verifier.privateJwk, now: later });
    const body = JSON.parse(admission.payload);

    // challenge marked held-out but the policy cell is published-only
    const wrongCell = { ...body, policy: { ...body.policy, cells: ["sat:t4"] } };
    const fakeAdmission = { protocol: admission.protocol, payload: canonical(wrongCell), signature: signBody(wrongCell, verifier.privateJwk) };
    expect(checkAdmission(fakeAdmission, { pool })).toEqual({ ok: false, reason: "challenge cell is outside the policy" });

    // strip the marker from one challenge under a holdout-only policy:
    // without the marker it names a published cell the policy never offered
    const onlyHold: GatePolicy = { suite: "frontier", cells: ["h:sat:t4"], challenges: 3, minPass: 2, ttlSeconds: 300 };
    const heldOnly = issueSession({ policy: onlyHold, verifierJwk: verifier.privateJwk, pool, pick: () => 0, seedBase: 42_000, now });
    const heldResponses = Object.fromEntries(heldOnly.session.tickets.map((t) => [t.challenge.challengeId, t.expected]));
    const { admission: heldAdmission } = submitSession({ session: heldOnly.session, responses: heldResponses, pool, verifierJwk: verifier.privateJwk, now: later });
    const heldBody = JSON.parse(heldAdmission.payload);
    const unmarked = { ...heldBody, challenges: heldBody.challenges.map((c: Challenge, i: number) => (i === 0 ? (({ heldout: _h, ...rest }) => rest)(c) : c)) };
    const fake2 = { protocol: heldAdmission.protocol, payload: canonical(unmarked), signature: signBody(unmarked, verifier.privateJwk) };
    expect(checkAdmission(fake2, { pool })).toEqual({ ok: false, reason: "challenge cell is outside the policy" });

    // two different poolKeys in one session
    const mixed = { ...body, challenges: body.challenges.map((c: Challenge, i: number) => (i === 1 ? { ...c, heldout: { poolKey: otherPool.poolKey } } : c)) };
    const fake3 = { protocol: admission.protocol, payload: canonical(mixed), signature: signBody(mixed, verifier.privateJwk) };
    expect(checkAdmission(fake3, { pool })).toEqual({ ok: false, reason: "held-out challenges mix pools" });
  });
});
