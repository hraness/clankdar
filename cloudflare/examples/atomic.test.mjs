import { describe, expect, test } from "bun:test";
import { check } from "./check.mjs";
import { verifyReceipt } from "./verify-receipt.mjs";
import { generateVerifier } from "../../bench/attest.ts";
import { issueSession, submitSession } from "../../bench/gate.ts";
import { canonical, sha256 } from "../../bench/canon.ts";

const issuer = generateVerifier();
const issuerPublicKey = issuer.publicKey;
const context = "room:request-123";
function receiptFixture(pass = true) {
  const now = new Date();
  const issued = issueSession({ policy: { suite: "v2", cells: ["arithmetic:t0"], challenges: 1, minPass: 1, ttlSeconds: 120 }, verifierJwk: issuer.privateJwk, now, context });
  const responses = pass ? Object.fromEntries(issued.session.tickets.map(ticket => [ticket.challenge.challengeId, ticket.expected])) : {};
  const receipt = submitSession({ session: issued.session, responses, verifierJwk: issuer.privateJwk, now }).admission;
  return { issued, responses, receipt, receiptText: canonical(receipt) };
}

describe("atomic HTTP example and offline verification", () => {
  test("uses only caller solver, binds the request, withholds token from submission and hashes exact downloaded bytes", async () => {
    const fixture = receiptFixture();
    const id = fixture.issued.session.sessionId;
    let calls = 0, solverCalls = 0;
    let saved, issuedRecord;
    const fetchMock = async (url, options) => {
      calls++;
      expect(options.redirect).toBe("error");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      if (calls === 1) {
        expect(url).toBe("https://clankdar.example/v1/checks");
        expect(options.headers.authorization).toBe("Bearer test-invitation");
        expect(JSON.parse(options.body)).toEqual({ policyId: "algal-floor-v1", context });
        return Response.json({ ok: true, id, ticket: "opaque-ticket", expiresAt: fixture.issued.session.expiresAt, challenges: fixture.issued.challenges });
      }
      expect(options.headers.authorization).toBeUndefined();
      if (calls === 2) {
        expect(saved).toMatchObject({ id, ticket: "opaque-ticket", responses: fixture.responses });
        expect(url).toBe(`https://clankdar.example/v1/checks/${id}/responses`);
        expect(JSON.parse(options.body)).toEqual({ ticket: "opaque-ticket", responses: fixture.responses });
        // The wrapper lies about pass; only the signed receipt determines it.
        return Response.json({ ok: true, id, pass: false, passed: 0, sha256: sha256(fixture.receiptText), receiptUrl: "https://untrusted.example/receipt" });
      }
      expect(url).toBe(`https://clankdar.example/v1/checks/${id}`);
      return new Response(fixture.receiptText);
    };
    const result = await check({ baseUrl: "https://clankdar.example", token: "test-invitation", context, fetch: fetchMock, onIssued: async record => { await Promise.resolve(); issuedRecord = structuredClone(record); record.challenges[0].prompt = "callback mutation"; }, checkpoint: async record => { await Promise.resolve(); saved = record; }, solve: async (challenges, signal) => {
      solverCalls++;
      expect(issuedRecord).toEqual({ id, ticket: "opaque-ticket", expiresAt: fixture.issued.session.expiresAt, challenges: fixture.issued.challenges, receiptUrl: `https://clankdar.example/v1/checks/${id}` });
      expect(issuedRecord).not.toHaveProperty("responses");
      expect(issuedRecord).not.toHaveProperty("token");
      expect(challenges).toEqual(fixture.issued.challenges);
      expect(signal).toBeInstanceOf(AbortSignal);
      return fixture.responses;
    } });
    expect(saved.receiptUrl).toBe(`https://clankdar.example/v1/checks/${id}`);
    expect(calls).toBe(3);
    expect(solverCalls).toBe(1);
    expect(result).not.toHaveProperty("pass");
    expect(verifyReceipt(result.receiptText, { issuerPublicKey, sessionId: result.id, context, sha256: result.sha256 })).toMatchObject({ ok: true, pass: true, passed: 1, required: 1, sha256: sha256(fixture.receiptText) });
  });

  test("failed persistence stops the flow before solving or submitting", async () => {
    const fixture = receiptFixture();
    for (const callback of ["onIssued", "checkpoint"]) {
      let calls = 0, solves = 0;
      await expect(check({
        baseUrl: "https://clankdar.example", token: "test-invitation",
        fetch: async () => { calls++; return Response.json({ id: fixture.issued.session.sessionId, ticket: "ticket", expiresAt: fixture.issued.session.expiresAt, challenges: fixture.issued.challenges }); },
        solve: async () => { solves++; return fixture.responses; },
        [callback]: async () => { await Promise.resolve(); throw new Error("private persistence unavailable"); },
      })).rejects.toThrow("private persistence unavailable");
      expect(calls).toBe(1);
      expect(solves).toBe(callback === "onIssued" ? 0 : 1);
    }
  });

  test("a ticket saved after its solver budget expires starts no solver", async () => {
    let calls = 0, solved = false, saved;
    await expect(check({
      baseUrl: "https://clankdar.example", token: "test-invitation",
      fetch: async () => { calls++; return Response.json({ id: "gs_aaaaaaaaaaaa", ticket: "ticket", expiresAt: new Date(Date.now() + 515).toISOString(), challenges: [{ challengeId: "att_aaaaaaaaaaaa" }] }); },
      onIssued: async record => { saved = record; await new Promise(resolve => setTimeout(resolve, 30)); },
      solve: async () => { solved = true; return {}; },
    })).rejects.toThrow("deadline");
    expect(saved).toMatchObject({ id: "gs_aaaaaaaaaaaa", ticket: "ticket" });
    expect(calls).toBe(1);
    expect(solved).toBe(false);
  });

  test("solver deadline aborts the supplied signal without submitting or reissuing", async () => {
    let calls = 0, saved, solverSignal;
    await expect(check({
      baseUrl: "https://clankdar.example", token: "test-invitation",
      fetch: async () => { calls++; return Response.json({ id: "gs_aaaaaaaaaaaa", ticket: "ticket", expiresAt: new Date(Date.now() + 550).toISOString(), challenges: [{ challengeId: "att_aaaaaaaaaaaa" }] }); },
      onIssued: async record => { saved = record; },
      solve: async (_challenges, signal) => { solverSignal = signal; return new Promise(() => {}); },
    })).rejects.toThrow("solver exceeded the check deadline");
    expect(solverSignal.aborted).toBe(true);
    expect(saved).toHaveProperty("ticket", "ticket");
    expect(calls).toBe(1);
  });

  test("verification requires a trusted issuer and rejects wrong context, session, hash, and tampering", () => {
    const { receiptText, receipt } = receiptFixture();
    expect(verifyReceipt(receiptText).ok).toBe(false);
    const stranger = generateVerifier();
    expect(verifyReceipt(receiptText, { issuerPublicKey: stranger.publicKey }).reason).toContain("pinned key");
    expect(verifyReceipt(receiptText, { issuerPublicKey, context: "another-room" }).reason).toContain("context");
    expect(verifyReceipt(receiptText, { issuerPublicKey, sessionId: "gs_aaaaaaaaaaaa" }).reason).toContain("session");
    expect(verifyReceipt(receiptText, { issuerPublicKey, sha256: "0".repeat(64) }).reason).toContain("SHA-256");
    const payload = JSON.parse(receipt.payload);
    payload.verdict.pass = false;
    expect(verifyReceipt({ ...receipt, payload: canonical(payload) }, { issuerPublicKey }).ok).toBe(false);
    expect(verifyReceipt({ ok: true, pass: true, receipt }, { issuerPublicKey }).reason).toContain("wrapper");
  });

  test("valid failing decisions stay failing and downloaded whitespace changes the exact hash", () => {
    const { receipt, receiptText } = receiptFixture(false);
    expect(verifyReceipt(receiptText, { issuerPublicKey })).toMatchObject({ ok: true, pass: false, passed: 0, required: 1 });
    const pretty = JSON.stringify(receipt, null, 2) + "\n";
    expect(verifyReceipt(pretty, { issuerPublicKey }).sha256).toBe(sha256(pretty));
    expect(verifyReceipt(pretty, { issuerPublicKey, sha256: sha256(receiptText) }).ok).toBe(false);
  });

  test("rejects unsafe inputs before issuing work and never echoes provider error bodies", async () => {
    let calls = 0;
    const fetchMock = async () => { calls++; return Response.json({ reason: "private-provider-detail" }, { status: 401 }); };
    const args = { baseUrl: "https://clankdar.example", token: "test-invitation", solve: async () => ({}), fetch: fetchMock };
    await expect(check({ ...args, baseUrl: "http://clankdar.example" })).rejects.toThrow("HTTPS");
    await expect(check({ ...args, baseUrl: "https://user:password@clankdar.example" })).rejects.toThrow("HTTPS");
    await expect(check({ ...args, solve: undefined })).rejects.toThrow("provide solve");
    await expect(check({ ...args, onIssued: true })).rejects.toThrow("onIssued must");
    await expect(check({ ...args, context: "" })).rejects.toThrow("nonempty");
    await expect(check({ ...args, context: "   " })).rejects.toThrow("nonempty");
    expect(calls).toBe(0);
    await expect(check(args)).rejects.toThrow("Clankdar request failed (401)");
    expect(calls).toBe(1);
  });

  test("refuses an expired check without calling the solver and detects substituted receipt bytes", async () => {
    let solved = false;
    await expect(check({ baseUrl: "https://clankdar.example", token: "test-invitation", solve: async () => { solved = true; return {}; }, fetch: async () => Response.json({ id: "gs_aaaaaaaaaaaa", ticket: "ticket", expiresAt: new Date(0).toISOString(), challenges: [{ challengeId: "att_aaaaaaaaaaaa" }] }) })).rejects.toThrow("deadline");
    expect(solved).toBe(false);
    const fixture = receiptFixture();
    let calls = 0;
    await expect(check({ baseUrl: "https://clankdar.example", token: "test-invitation", solve: async () => fixture.responses, fetch: async () => {
      calls++;
      if (calls === 1) return Response.json({ id: fixture.issued.session.sessionId, ticket: "ticket", expiresAt: fixture.issued.session.expiresAt, challenges: fixture.issued.challenges });
      if (calls === 2) return Response.json({ id: fixture.issued.session.sessionId, sha256: "0".repeat(64) });
      return new Response(fixture.receiptText);
    } })).rejects.toThrow("differs from the submitted decision");
  });
});
