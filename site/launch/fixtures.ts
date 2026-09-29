/**
 * The recorded local demo run the launch mockups draw from. `bun run try`
 * wrote these two files; the receipt is verified with the repository's own
 * verifier in launch.test.ts, so a mockup can only show what a real run
 * produced.
 */
import receipt from "./fixtures/demo-receipt.json" with { type: "json" };
import verification from "./fixtures/demo-verification.json" with { type: "json" };
import failReceipt from "./fixtures/fail-receipt.json" with { type: "json" };
import failVerification from "./fixtures/fail-verification.json" with { type: "json" };
import tamperedReceipt from "./fixtures/tampered-receipt.json" with { type: "json" };

type ChallengeSummary = Readonly<{ challengeId: string; tier: number; family: string }>;
type Verdict = Readonly<{ pass: boolean; passed: number; required: number; decidedAt: string }>;

type Payload = {
  challenges: (ChallengeSummary & { expiresAt: string })[];
  policy: { challenges: number; minPass: number; ttlSeconds: number; suite: string };
  receipts: { payload: string }[];
  verdict: Verdict;
};

function summarize(signed: { payload: string }, record: { sessionId: string; context: string; issuerPublicKey: string; sha256: string }) {
  const payload = JSON.parse(signed.payload) as Payload;
  return Object.freeze({
    sessionId: record.sessionId,
    context: record.context,
    issuer: record.issuerPublicKey,
    sha256: record.sha256,
    policy: payload.policy,
    verdict: payload.verdict,
    expiresAt: payload.challenges[0]!.expiresAt,
    puzzles: payload.challenges.map((challenge, index) => {
      const scored = JSON.parse(payload.receipts[index]!.payload) as { expected: string; response: string; verdict: { pass: boolean; answeredAt: string } };
      return Object.freeze({ id: challenge.challengeId, tier: challenge.tier, family: challenge.family, expected: scored.expected, response: scored.response, pass: scored.verdict.pass });
    }),
  });
}

export const DEMO_RECEIPT = receipt;
export const DEMO_VERIFICATION = verification;
/** The results directory `bun run try` wrote, as the demo printed it. */
export const DEMO_RESULTS_DIR = "results/try-KWF0ar";

export const DEMO_RUN = summarize(receipt, verification);

/** A real `bun run try --solver` run with a solver that always answers 33, which fails every puzzle. */
export const FAIL_RECEIPT = failReceipt;
export const FAIL_VERIFICATION = failVerification;
export const FAIL_RESULTS_DIR = "results/try-u1MDii";
export const FAIL_RUN = summarize(failReceipt, failVerification);

/**
 * The demo receipt with one answer edited from 515 to 514 and its signature
 * left alone. `verify-receipt.mjs` rejects it; launch.test.ts runs that.
 */
export const TAMPERED_RECEIPT = tamperedReceipt;
export const TAMPER = Object.freeze({ from: "515", to: "514", verifierOutput: '{"ok":false,"reason":"receipt did not verify: signature does not verify"}' });

/** Shortens a key or hash for a narrow terminal line, keeping both ends. */
export function shortId(value: string, keep = 8): string {
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}
