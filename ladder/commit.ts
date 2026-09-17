import { createHash } from "node:crypto";
import { normalize } from "./family.ts";

const DOMAIN = "clankdar/ladder/v1\0";

/**
 * The ladder-mode answer commitment: the issuer signs only this digest into the
 * challenge, so the wire never carries the answer. Verification is hash equality
 * against a normalized response.
 */
export function answerCommitment(challengeId: string, answer: string): string {
  return createHash("sha256")
    .update(DOMAIN)
    .update(challengeId)
    .update(normalize(answer))
    .digest("hex");
}

export function verifyAnswer(challengeId: string, commitment: string, response: string): boolean {
  return answerCommitment(challengeId, response) === commitment;
}
