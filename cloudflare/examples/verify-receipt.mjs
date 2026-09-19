#!/usr/bin/env bun
/** Offline verification reuses the protocol checker; no network or model calls. */
import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { checkAdmission } from "../../bench/gate.ts";
import { canonical, sha256 } from "../../bench/canon.ts";

/**
 * The issuer key must come from your own trusted configuration, not this receipt.
 * String/Uint8Array input hashes exact downloaded bytes. Object input hashes the
 * canonical admission encoding used by the hosted endpoint.
 * Callers must require pass:true and enforce their own policy and freshness
 * using the checked policy and signed decidedAt/expiresAt values returned here.
 */
export function verifyReceipt(input, { issuerPublicKey, context, sessionId, sha256: expectedHash } = {}) {
  const fail = reason => ({ ok: false, reason });
  if (typeof issuerPublicKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(issuerPublicKey)) return fail("a pinned issuer public key is required");
  if (context !== undefined && typeof context !== "string") return fail("expected context must be a string");
  if (sessionId !== undefined && !/^gs_[A-Za-z0-9_-]{12}$/.test(sessionId)) return fail("expected session ID is malformed");
  if (expectedHash !== undefined && !/^[0-9a-f]{64}$/.test(expectedHash)) return fail("expected SHA-256 is malformed");
  try {
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input instanceof Uint8Array ? input : new TextEncoder().encode(canonical(input));
    if (bytes.byteLength > 1_048_576) return fail("receipt is too large");
    const hash = sha256(bytes);
    if (expectedHash !== undefined && expectedHash !== hash) return fail("receipt SHA-256 does not match");
    const receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (receipt?.protocol !== "clankdar-gate-v1" || typeof receipt.payload !== "string") return fail("expected a portable gate receipt, not an API response wrapper");
    const body = JSON.parse(receipt.payload);
    if (!Array.isArray(body?.challenges) || !body.challenges.length || body.challenges.some(challenge => challenge?.verifier?.publicKey !== issuerPublicKey)) return fail("receipt issuer does not match the pinned key");
    if (context !== undefined && body.context !== context) return fail("receipt context does not match");
    if (sessionId !== undefined && body.sessionId !== sessionId) return fail("receipt session does not match");
    const replay = checkAdmission(receipt);
    if (!replay.ok) return fail(`receipt did not verify: ${replay.reason}`);
    if (replay.unreplayed) return fail("receipt includes scores that cannot be independently replayed");
    return { ok: true, sha256: hash, issuerPublicKey, sessionId: body.sessionId, ...(body.context === undefined ? {} : { context: body.context }), pass: replay.verdict, passed: replay.passed, required: body.policy.minPass, policy: body.policy, decidedAt: body.verdict.decidedAt, expiresAt: body.challenges[0].expiresAt };
  } catch { return fail("receipt is malformed or cannot be replayed"); }
}

if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({ args: process.argv.slice(2), options: { issuer: { type: "string" }, context: { type: "string" }, session: { type: "string" }, sha256: { type: "string" }, help: { type: "boolean", short: "h" } }, strict: true, allowPositionals: true });
    if (values.help) console.log("usage: bun cloudflare/examples/verify-receipt.mjs RECEIPT.json --issuer PUBLIC_KEY [--context STRING] [--session gs_…] [--sha256 HEX]\nValid receipts may have pass:false; callers must require pass:true for admission.");
    else {
      if (positionals.length !== 1 || !values.issuer) throw new Error("provide one receipt file and --issuer PUBLIC_KEY (use --help)");
      const file = statSync(positionals[0]);
      if (!file.isFile() || file.size > 1_048_576) throw new Error("receipt must be a file no larger than 1 MiB");
      const result = verifyReceipt(readFileSync(positionals[0]), { issuerPublicKey: values.issuer, context: values.context, sessionId: values.session, sha256: values.sha256 });
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 2;
    }
  } catch (error) { console.error(error instanceof Error ? error.message : "receipt verification failed"); process.exitCode = 2; }
}
