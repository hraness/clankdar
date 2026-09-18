import { describe, expect, test } from "bun:test";
import { generateVerifier, issueChallenge, verifyResponse, checkReceipt, seedCommit, canonical, type Receipt, type Ticket } from "./attest.ts";

const verifier = generateVerifier();
const opts = (over: Partial<Parameters<typeof issueChallenge>[0]> = {}) => ({
  suite: "frontier" as const, family: "automata", tier: 6, seed: 424242,
  ttlSeconds: 300, verifierJwk: verifier.privateJwk, now: new Date("2026-09-18T00:00:00Z"), ...over,
});

const issued = issueChallenge(opts());
const passTicket = issued.ticket;
const passReceipt = verifyResponse({ ticket: passTicket, response: issued.instance.answer, verifierJwk: verifier.privateJwk, now: new Date("2026-09-18T00:01:00Z") });
const failReceipt = verifyResponse({ ticket: passTicket, response: issued.instance.answer.replace(/./g, (c) => (c === "0" ? "1" : "0")), verifierJwk: verifier.privateJwk, now: new Date("2026-09-18T00:01:00Z") });

describe("sealed-seed attestation", () => {
  test("challenge seals the seed but binds it and the verifier", () => {
    const { challenge } = issued;
    expect(JSON.stringify(challenge)).not.toContain(String(opts().seed));
    expect(challenge.seedCommit).toMatch(/^[a-f0-9]{64}$/);
    expect(challenge.seedCommit).toBe(seedCommit(challenge, opts().seed!));
    expect(challenge.seedCommit).not.toBe(seedCommit(challenge, 999999));
    expect(challenge.verifier.keyId).toMatch(/^[a-f0-9]{16}$/);
    expect(challenge.prompt).toBe(issued.instance.prompt);
  });

  test("a correct response produces a passing receipt that replays", () => {
    const result = checkReceipt(passReceipt);
    expect(result).toEqual({ ok: true, verdict: true });
  });

  test("a wrong response produces a truthful failing receipt", () => {
    const body = JSON.parse(failReceipt.payload);
    expect(body.verdict.pass).toBe(false);
    expect(checkReceipt(failReceipt)).toEqual({ ok: true, verdict: false });
  });

  test("check rejects tampering at every layer", () => {
    const body = JSON.parse(passReceipt.payload);
    const cases: Receipt[] = [
      { ...passReceipt, signature: passReceipt.signature.slice(0, -4) + "AAAA" },
      { ...passReceipt, payload: JSON.stringify({ ...body, seed: body.seed + 1 }) },
      { ...passReceipt, payload: JSON.stringify({ ...body, verdict: { ...body.verdict, pass: !body.verdict.pass } }) },
      { ...passReceipt, payload: JSON.stringify({ ...body, response: "0" }) },
      { ...passReceipt, payload: JSON.stringify({ ...body, challenge: { ...body.challenge, prompt: "forged" } }) },
      { protocol: "clankdar-attest-v1", payload: "{}", signature: "x" },
    ];
    for (const receipt of cases) expect(checkReceipt(receipt).ok).toBe(false);
  });

  test("a receipt forged under a different key fails signature verification", () => {
    const other = generateVerifier();
    const foreign = issueChallenge(opts({ verifierJwk: other.privateJwk }));
    const receipt = verifyResponse({ ticket: foreign.ticket, response: "wrong", verifierJwk: verifier.privateJwk, now: new Date("2026-09-18T00:01:00Z") });
    expect(checkReceipt(receipt).ok).toBe(false);
  });

  test("expired tickets refuse verification and late answers fail check", () => {
    const { ticket } = issued;
    expect(() => verifyResponse({ ticket, response: "1", verifierJwk: verifier.privateJwk, now: new Date("2026-09-18T00:10:00Z") })).toThrow("expired");
    const late = verifyResponse({ ticket, response: issued.instance.answer, verifierJwk: verifier.privateJwk, now: new Date("2026-09-18T00:04:59Z") });
    const body = JSON.parse(late.payload);
    body.verdict.answeredAt = "2026-09-18T00:06:00Z";
    expect(checkReceipt({ ...late, payload: JSON.stringify(body) }).ok).toBe(false);
  });

  test("unknown cells and bad options fail at issue", () => {
    for (const over of [
      { family: "typo" }, { tier: 99 }, { seed: -1 }, { seed: 2 ** 32 }, { ttlSeconds: 5 }, { ttlSeconds: 99999 }, { context: "x".repeat(300) },
    ] as const) expect(() => issueChallenge(opts(over as object))).toThrow();
  });

  test("canonical is deterministic and order-insensitive for signing", () => {
    const a = canonical({ b: 1, a: { z: 2, y: [3] } });
    const b = canonical({ a: { y: [3], z: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"y":[3],"z":2},"b":1}');
  });
});
