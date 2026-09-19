import { describe, expect, test } from "bun:test";
import { checkAdmission } from "../bench/gate.ts";
import { b64url, canonical } from "./src/protocol.ts";
import { HOSTED_POLICIES, issueHostedSession, submitHostedSession } from "./src/challenges.ts";
import { issuerIdentity } from "./src/issuer.ts";

const encoder = new TextEncoder();

describe("Cloudflare challenge interoperability", () => {
  test("Worker-minted receipts and admissions replay in the TypeScript reference checker", async () => {
    const actorKeys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const actorJwk = await crypto.subtle.exportKey("jwk", actorKeys.publicKey) as JsonWebKey;
    const publicKey = actorJwk.x!;
    const issuer = await issuerIdentity("test", "test");
    const now = new Date("2026-09-19T07:00:00Z");
    const issued = await issueHostedSession({
      policy: HOSTED_POLICIES["v2-floor-v1"], actor: "clank1_test", campaignId: "cmp_testcampaign1", epoch: 0,
      issuer, now, expiresAt: new Date(now.getTime() + 120_000),
    });
    const proofTranscript = canonical(["clankdar/subject/v1", issued.secret.sessionId, publicKey]);
    const subjectProof = { publicKey, signature: b64url(await crypto.subtle.sign("Ed25519", actorKeys.privateKey, encoder.encode(proofTranscript))) };
    const responses = Object.fromEntries(issued.secret.tickets.map((ticket) => [ticket.challenge.challengeId, ticket.expected]));
    const result = await submitHostedSession({ session: issued.secret, responses, subjectProof, actorPublicKey: publicKey, issuer, now: new Date(now.getTime() + 1_000) });
    expect(result).toMatchObject({ passed: 4, verdict: true });
    expect(checkAdmission(result.admission)).toEqual({ ok: true, verdict: true, passed: 4 });
  });

  test("subject proof, deadline, and response ids fail closed", async () => {
    const actorKeys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const actorJwk = await crypto.subtle.exportKey("jwk", actorKeys.publicKey) as JsonWebKey;
    const publicKey = actorJwk.x!;
    const issuer = await issuerIdentity("test", "test");
    const now = new Date("2026-09-19T07:00:00Z");
    const issued = await issueHostedSession({ policy: HOSTED_POLICIES["v2-floor-v1"], actor: "clank1_test", campaignId: "cmp_testcampaign2", epoch: 0, issuer, now, expiresAt: new Date(now.getTime() + 30_000) });
    await expect(submitHostedSession({ session: issued.secret, responses: { unknown: "x" }, subjectProof: { publicKey, signature: "bad" }, actorPublicKey: publicKey, issuer, now })).rejects.toThrow("subject proof");
    await expect(submitHostedSession({ session: issued.secret, responses: {}, subjectProof: { publicKey, signature: "bad" }, actorPublicKey: publicKey, issuer, now: new Date(now.getTime() + 31_000) })).rejects.toThrow("expired");
  });
});
