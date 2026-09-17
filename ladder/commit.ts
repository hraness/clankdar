import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalAnswer, SCORER_VERSION, type AnswerFormat } from "./family.ts";

const DOMAIN = "clankdar/answer/v2\0";

/**
 * A verifier-keyed answer commitment, not a complete admission protocol.
 * Public hashes of small answer spaces allow offline guessing; the key stays
 * server-side. The caller must separately bind scope, expiry, and replay state.
 */
export function answerCommitment(challengeId: string, answer: string, verifierKey: Uint8Array, format: AnswerFormat = "text"): string {
  if (!(verifierKey instanceof Uint8Array) || verifierKey.length < 32 || verifierKey.length > 64) throw new Error("a 32–64 byte verifier key is required");
  if (typeof challengeId !== "string" || !challengeId.length || challengeId.length > 256) throw new Error("invalid challenge ID");
  const canonical = canonicalAnswer(answer, format);
  if (canonical === null) throw new Error("invalid answer for the declared format");
  return createHmac("sha256", verifierKey)
    .update(JSON.stringify([DOMAIN, SCORER_VERSION, challengeId, format, canonical]))
    .digest("hex");
}

export function verifyAnswer(challengeId: string, commitment: string, response: string, verifierKey: Uint8Array, format: AnswerFormat = "text"): boolean {
  if (typeof commitment !== "string" || !/^[a-f0-9]{64}$/.test(commitment) || canonicalAnswer(response, format) === null) return false;
  const expected = answerCommitment(challengeId, response, verifierKey, format);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(commitment, "hex"));
}
