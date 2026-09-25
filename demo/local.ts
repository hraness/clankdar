/** Credential-free local protocol demonstration. This is not a hosted issuer. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { issueCheckSession, submitCheckSession, HOSTED_POLICIES, type HostedChallenge } from "../cloudflare/src/challenges.ts";
import { b64url, canonical, sha256, unb64url } from "../cloudflare/src/protocol.ts";
import type { IssuerIdentity } from "../cloudflare/src/issuer.ts";
import { verifyReceipt, type VerifiedReceipt } from "../cloudflare/examples/verify-receipt.mjs";
import { solveAlgalPuzzle, type AlgalPuzzle } from "../ladder/families/algal.ts";
import { ALGAL_FUEL_LIMIT, ALGAL_WASM_SHA256 } from "../ladder/algal/provenance.ts";

export type LocalSolver = (challenges: HostedChallenge[], signal: AbortSignal) => Record<string, string> | Promise<Record<string, string>>;
export interface LocalCheckResult {
  id: string; context: string; issuerPublicKey: string; sha256: string;
  receiptText: string; verified: VerifiedReceipt; solver: "scripted" | "custom";
}

/** Solves only the public expression and inputs; never reads a seed or expected answer. */
export const solveAlgalChallenges: LocalSolver = (challenges, signal) => Object.fromEntries(challenges.map((challenge) => {
  signal.throwIfAborted();
  if (challenge.suiteVersion !== "clankdar-algal-v1" || challenge.family !== "algal") throw new Error("the scripted solver accepts ALGAL v1 challenges only");
  const match = /^Expression: (.+)\nInputs: (.+)\nFuel limit: (\d+)\nEvaluator SHA-256: ([0-9a-f]{64})$/m.exec(challenge.prompt);
  if (!match || Number(match[3]) !== ALGAL_FUEL_LIMIT || match[4] !== ALGAL_WASM_SHA256) throw new Error("the public ALGAL prompt is malformed or uses a different evaluator");
  const puzzle: AlgalPuzzle = { expr: JSON.parse(match[1]), inputs: JSON.parse(match[2]), fuelLimit: ALGAL_FUEL_LIMIT };
  return [challenge.challengeId, solveAlgalPuzzle(puzzle).answer];
}));

async function localIssuer(): Promise<IssuerIdentity> {
  // Keep the signing key non-extractable and in memory for this one check.
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = (await crypto.subtle.exportKey("jwk", pair.publicKey)).x!;
  return { publicKey, keyId: (await sha256(unb64url(publicKey))).slice(0, 16),
    sign: async (payload) => b64url(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(payload))) };
}

/**
 * Same issue/submit primitives and wire receipt as the hosted API, with a fresh
 * local issuer. No network, storage, credentials, or model calls by default.
 * A supplied callback is trusted local code; forward its signal to async work.
 */
export async function runLocalCheck(options: { solve?: LocalSolver; context?: string; signal?: AbortSignal } = {}): Promise<LocalCheckResult> {
  const context = options.context ?? "clankdar:local-demo";
  if (typeof context !== "string" || !context.trim() || context.length > 256) throw new Error("context must be a nonempty string up to 256 characters");
  if (options.solve !== undefined && typeof options.solve !== "function") throw new Error("solve must be a function");
  options.signal?.throwIfAborted();
  const issuer = await localIssuer();
  const policy = HOSTED_POLICIES["algal-floor-v1"];
  const now = new Date();
  const expiresAt = new Date(now.getTime() + policy.ttlSeconds * 1000);
  const issued = await issueCheckSession({ policy, issuer, now, expiresAt, context });
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, Math.max(0, expiresAt.getTime() - Date.now() - 500));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let rejectAbort: (() => void) | undefined;
  try {
    controller.signal.throwIfAborted();
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new Error("solver exceeded the check deadline or was cancelled"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const solved = Promise.resolve().then(() => (options.solve ?? solveAlgalChallenges)(structuredClone(issued.challenges), controller.signal))
      .catch(() => { throw new Error("solver failed; check your local solver module"); });
    const responses = await Promise.race([solved, aborted]);
    controller.signal.throwIfAborted();
    const known = new Set(issued.challenges.map((challenge) => challenge.challengeId));
    if (!responses || typeof responses !== "object" || Array.isArray(responses) || Object.entries(responses).some(([id, value]) => !known.has(id) || typeof value !== "string") || new TextEncoder().encode(JSON.stringify(responses)).length > 120_000) throw new Error("solver must return an object mapping challenge IDs to response strings, at most 120000 bytes");
    const result = await submitCheckSession({ session: issued.secret, responses, issuer, now: new Date() });
    const receiptText = canonical(result.admission);
    if (new TextEncoder().encode(receiptText).length > 262_144) throw new Error("receipt exceeds the 256 KiB limit");
    const hash = await sha256(receiptText);
    const verified = verifyReceipt(receiptText, { issuerPublicKey: issuer.publicKey, sessionId: issued.secret.sessionId, context, sha256: hash });
    if (!verified.ok) throw new Error("local receipt did not independently verify");
    return { id: issued.secret.sessionId, context, issuerPublicKey: issuer.publicKey, sha256: hash, receiptText, verified, solver: options.solve ? "custom" : "scripted" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
  }
}

/** Saves only public evidence, creating a new directory and never overwriting. */
export function saveLocalCheck(result: LocalCheckResult, resultsDirectory = resolve("results")): { receiptPath: string; verificationPath: string } {
  const pins = { issuerPublicKey: result.issuerPublicKey, sessionId: result.id, context: result.context, sha256: result.sha256 };
  if (!verifyReceipt(result.receiptText, pins).ok) throw new Error("refusing to save an unverified receipt");
  mkdirSync(resultsDirectory, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(resultsDirectory, "try-"));
  const receiptPath = join(directory, "receipt.json");
  const verificationPath = join(directory, "verification.json");
  writeFileSync(receiptPath, result.receiptText, { flag: "wx", mode: 0o600 });
  writeFileSync(verificationPath, JSON.stringify({ provenance: "local-demo", solver: result.solver, ...pins }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (!verifyReceipt(readFileSync(receiptPath), pins).ok) throw new Error("saved receipt did not independently verify");
  return { receiptPath, verificationPath };
}
