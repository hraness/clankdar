#!/usr/bin/env bun
/**
 * Sealed-seed capability attestation — reference implementation.
 *
 *   bun bench/attest.ts keygen --out verifier.pem
 *   bun bench/attest.ts issue --key verifier.pem --suite frontier --family cryptarithm --tier 5 --ttl 300 --out ticket.json
 *   bun bench/attest.ts verify --key verifier.pem --ticket ticket.json --response-file answer.txt --out receipt.json
 *   bun bench/attest.ts check receipt.json
 *
 * A verifier issues a challenge whose seed is committed but unrevealed: the
 * instance has never existed publicly, so it cannot be pre-solved or looked
 * up. On a response the verifier rescores deterministically and signs a
 * receipt that reveals the seed — afterward anyone regenerates the instance,
 * rescores the response, and checks the signature without trusting the
 * verifier beyond the episode it signed. The signature covers the payload
 * bytes verbatim, so checkers never re-serialize.
 *
 * Scope: a receipt attests that one signed response satisfied one challenge
 * inside one time window. It is not a liveness credential, does not prove a
 * model (or AI) produced the response, grants no authority, and provides no
 * durable replay protection — consumers should issue fresh challenges.
 */
import { parseArgs } from "node:util";
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes, sign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { poolForVersion, suiteVersion, type SuiteName } from "../ladder/mod.ts";
import { answerFormat, scoreAnswer, canonicalAnswer, MAX_ANSWER_LENGTH, type AnswerFormat, type Instance } from "../ladder/family.ts";

export const ATTEST_PROTOCOL = "clankdar-attest-v1";
const COMMIT_DOMAIN = "clankdar/attest-seed/v1";
const SUITES: SuiteName[] = ["v2", "frontier", "agent"];

export interface Challenge {
  protocol: typeof ATTEST_PROTOCOL;
  kind: "challenge";
  challengeId: string;
  suiteVersion: string;
  family: string;
  tier: number;
  prompt: string;
  seedCommit: string;
  nonce: string;
  expiresAt: string;
  context?: string;
  /** Opaque relying-party subject claim (e.g. an agent or session key id). */
  subject?: string;
  /** Gate session this challenge was issued under (clankdar-gate-v1). */
  sessionId?: string;
  verifier: { keyId: string; publicKey: string };
}

export interface Ticket {
  challenge: Challenge;
  /** Verifier-side only until a receipt reveals it. */
  seed: number;
  /** Canonical expected answer, held by the verifier until reveal. */
  expected: string;
}

/** The signed body, serialized inside `Receipt.payload`. */
export interface ReceiptBody {
  kind: "receipt";
  challenge: Challenge;
  seed: number;
  expected: string;
  response: string;
  verdict: { pass: boolean; format: AnswerFormat; answeredAt: string };
}

export interface Receipt {
  protocol: typeof ATTEST_PROTOCOL;
  payload: string;
  signature: string;
}

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** Deterministic JSON for signing: keys sorted by code-unit order recursively. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

/** Language-trivial seed commitment: fixed-field \0-joined digest. */
export const seedCommit = (challenge: Pick<Challenge, "suiteVersion" | "family" | "tier" | "nonce">, seed: number): string =>
  sha256([COMMIT_DOMAIN, challenge.suiteVersion, challenge.family, challenge.tier, challenge.nonce, seed].join("\0"));

/** Verifier private key is an Ed25519 JWK ({kty, crv, x, d}); the `x` member is the public key. */
export interface VerifierJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  d: string;
  [key: string]: unknown;
}

const privateKey = (jwk: unknown): KeyObject => {
  try {
    const key = createPrivateKey({ key: jwk as VerifierJwk, format: "jwk" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
    return key;
  } catch {
    throw new Error("verifier key must be an Ed25519 JWK");
  }
};

/** Build a verifying key from a base64url Ed25519 JWK `x` member. */
export const publicJwk = (publicKeyB64: string): KeyObject => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyB64 }, format: "jwk" });

/** The base64url public key member derived from a verifier private JWK. */
export const publicKeyOf = (jwk: VerifierJwk): string => (createPublicKey(privateKey(jwk)).export({ format: "jwk" }) as { x: string }).x;

/** Sign a body's canonical serialization verbatim; returns base64url. */
export const signBody = (body: unknown, jwk: VerifierJwk): string => b64url(sign(null, Buffer.from(canonical(body)), privateKey(jwk)));

/** Verify a base64url Ed25519 signature over a body's canonical serialization. */
export const verifyBodySignature = (body: unknown, signatureB64: string, publicKeyB64: string): boolean => {
  try {
    return cryptoVerify(null, Buffer.from(canonical(body)), publicJwk(publicKeyB64), Buffer.from(signatureB64, "base64url"));
  } catch {
    return false;
  }
};

export const keyIdOf = (publicKeyB64: string): string => sha256(Buffer.from(publicKeyB64, "base64url")).slice(0, 16);

export function generateVerifier(): { privateJwk: VerifierJwk; publicKey: string; keyId: string } {
  const pair = generateKeyPairSync("ed25519");
  const jwk = pair.privateKey.export({ format: "jwk" }) as VerifierJwk;
  return { privateJwk: jwk, publicKey: jwk.x, keyId: keyIdOf(jwk.x) };
}

export interface IssueOptions {
  suite: SuiteName;
  family: string;
  tier: number;
  seed?: number;
  ttlSeconds?: number;
  context?: string;
  subject?: string;
  sessionId?: string;
  verifierJwk: VerifierJwk;
  now?: Date;
}

/** Mint a sealed challenge plus the verifier-side ticket holding the seed. */
export function issueChallenge(opts: IssueOptions): { challenge: Challenge; ticket: Ticket; instance: Instance } {
  const version = suiteVersion(opts.suite);
  const family = poolForVersion(version).find((f) => f.name === opts.family);
  if (!family || !family.tiers.includes(opts.tier)) throw new Error(`unknown cell for suite ${opts.suite}: ${opts.family}:t${opts.tier}`);
  const seed = opts.seed ?? randomBytes(4).readUInt32BE(0);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("seed must be a uint32");
  const ttl = opts.ttlSeconds ?? 300;
  if (!Number.isInteger(ttl) || ttl < 10 || ttl > 86_400) throw new Error("ttl must be 10..86400 seconds");
  if (opts.context !== undefined && (typeof opts.context !== "string" || opts.context.length > 256)) throw new Error("context must be a string up to 256 chars");
  if (opts.subject !== undefined && (typeof opts.subject !== "string" || !opts.subject.length || opts.subject.length > 256)) throw new Error("subject must be a nonempty string up to 256 chars");
  if (opts.sessionId !== undefined && (typeof opts.sessionId !== "string" || !/^gs_[A-Za-z0-9_-]{12}$/.test(opts.sessionId))) throw new Error("sessionId must be a gate session id");
  const publicKey = publicKeyOf(opts.verifierJwk);
  const instance = family.generate(opts.tier, seed);
  const now = opts.now ?? new Date();
  const challenge: Challenge = {
    protocol: ATTEST_PROTOCOL, kind: "challenge", challengeId: `att_${b64url(randomBytes(9))}`,
    suiteVersion: version, family: family.name, tier: opts.tier, prompt: instance.prompt,
    seedCommit: "", nonce: b64url(randomBytes(12)), expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    ...(opts.context !== undefined ? { context: opts.context } : {}),
    ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    verifier: { keyId: "", publicKey },
  };
  challenge.verifier.keyId = keyIdOf(challenge.verifier.publicKey);
  challenge.seedCommit = seedCommit(challenge, seed);
  const expected = canonicalAnswer(instance.answer, answerFormat(family.name));
  if (expected === null) throw new Error("generated answer is not canonical");
  return { challenge, ticket: { challenge, seed, expected }, instance };
}

export interface VerifyOptions {
  ticket: Ticket;
  response: string;
  verifierJwk: VerifierJwk;
  now?: Date;
}

/** Rescore the response and sign a seed-revealing receipt. Expired tickets refuse. */
export function verifyResponse(opts: VerifyOptions): Receipt {
  const { challenge, seed, expected } = opts.ticket;
  const now = opts.now ?? new Date();
  if (challenge?.protocol !== ATTEST_PROTOCOL || challenge.kind !== "challenge") throw new Error("not an attestation challenge");
  if (!Number.isInteger(seed) || challenge.seedCommit !== seedCommit(challenge, seed)) throw new Error("ticket seed does not match the committed challenge");
  if (now.getTime() > Date.parse(challenge.expiresAt)) throw new Error("challenge expired");
  if (typeof opts.response !== "string" || opts.response.length > MAX_ANSWER_LENGTH) throw new Error("response missing or oversized");
  const instance = poolForVersion(challenge.suiteVersion).find((f) => f.name === challenge.family)!.generate(challenge.tier, seed);
  if (instance.prompt !== challenge.prompt) throw new Error("challenge prompt does not regenerate from the committed seed");
  const format = answerFormat(challenge.family);
  if (canonicalAnswer(expected, format) !== expected || canonicalAnswer(instance.answer, format) !== expected) throw new Error("ticket answer does not match the regenerated instance");
  const scored = scoreAnswer(instance.answer, opts.response, format);
  const body: ReceiptBody = {
    kind: "receipt", challenge, seed, expected,
    response: opts.response, verdict: { pass: scored.pass, format, answeredAt: now.toISOString() },
  };
  const signature = sign(null, Buffer.from(canonical(body)), privateKey(opts.verifierJwk));
  return { protocol: ATTEST_PROTOCOL, payload: canonical(body), signature: b64url(signature) };
}

export interface CheckResult {
  ok: boolean;
  verdict?: boolean;
  reason?: string;
}

/**
 * Independently replay a receipt: signature over the payload bytes, seed
 * binding, instance regeneration, rescore, timing. Needs no trust beyond the
 * recorded episode.
 */
export function checkReceipt(receipt: Receipt): CheckResult {
  const fail = (reason: string): CheckResult => ({ ok: false, reason });
  if (receipt?.protocol !== ATTEST_PROTOCOL || typeof receipt.payload !== "string" || typeof receipt.signature !== "string") return fail("not an attestation receipt");
  let body: ReceiptBody;
  try {
    body = JSON.parse(receipt.payload);
  } catch {
    return fail("payload is not JSON");
  }
  if (body?.kind !== "receipt" || body.challenge?.protocol !== ATTEST_PROTOCOL) return fail("malformed receipt payload");
  const { challenge, seed, expected, response, verdict } = body;
  let key: KeyObject;
  try {
    key = publicJwk(challenge.verifier.publicKey);
  } catch {
    return fail("verifier public key is not an Ed25519 JWK point");
  }
  if (keyIdOf(challenge.verifier.publicKey) !== challenge.verifier.keyId) return fail("verifier keyId does not match the public key");
  if (!cryptoVerify(null, Buffer.from(receipt.payload), key, Buffer.from(receipt.signature, "base64url"))) return fail("signature does not verify");
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return fail("revealed seed is not a uint32");
  if (challenge.seedCommit !== seedCommit(challenge, seed)) return fail("revealed seed does not match the committed challenge");
  let instance: Instance;
  try {
    const family = poolForVersion(challenge.suiteVersion).find((f) => f.name === challenge.family);
    if (!family || !family.tiers.includes(challenge.tier)) return fail("unknown cell for the recorded suite version");
    instance = family.generate(challenge.tier, seed);
  } catch (error) {
    return fail(`instance does not regenerate: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (instance.prompt !== challenge.prompt) return fail("recorded prompt disagrees with regeneration");
  const format = answerFormat(challenge.family);
  if (verdict.format !== format || canonicalAnswer(response, format) === null) return fail("response is not in the declared answer format");
  if (canonicalAnswer(expected, format) !== expected || canonicalAnswer(instance.answer, format) !== expected) return fail("recorded answer disagrees with regeneration");
  if (scoreAnswer(instance.answer, response, format).pass !== verdict.pass) return fail("verdict does not rescore");
  if (Date.parse(verdict.answeredAt) > Date.parse(challenge.expiresAt)) return fail("answer is later than the challenge expiry");
  return { ok: true, verdict: verdict.pass };
}

function loadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function main(args = process.argv.slice(2)): void {
  const [command, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      key: { type: "string" }, out: { type: "string" }, suite: { type: "string" }, family: { type: "string" },
      tier: { type: "string" }, seed: { type: "string" }, ttl: { type: "string" }, context: { type: "string" },
      ticket: { type: "string" }, "response-file": { type: "string" }, help: { type: "boolean", short: "h" },
    },
    allowPositionals: true, strict: true,
  });
  const usage = "usage: attest keygen --out KEY.json | issue --key KEY.json --suite v2|frontier|agent --family NAME --tier N [--seed N] [--ttl SEC] [--context TEXT] [--out TICKET.json] | verify --key KEY.json --ticket TICKET.json --response-file FILE [--out RECEIPT.json] | check RECEIPT.json";
  if (values.help || !command) { console.log(usage); return; }
  if (command === "keygen") {
    if (!values.out) throw new Error("keygen requires --out");
    const verifier = generateVerifier();
    writeFileSync(values.out, JSON.stringify(verifier.privateJwk, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ keyId: verifier.keyId, publicKey: verifier.publicKey, privateKeyFile: values.out }));
    return;
  }
  if (command === "issue") {
    if (!values.key || !values.suite || !values.family || values.tier === undefined) throw new Error("issue requires --key --suite --family --tier");
    if (!SUITES.includes(values.suite as SuiteName)) throw new Error(`suite must be one of ${SUITES.join(", ")}`);
    const issued = issueChallenge({
      suite: values.suite as SuiteName, family: values.family, tier: Number(values.tier),
      seed: values.seed !== undefined ? Number(values.seed) : undefined,
      ttlSeconds: values.ttl !== undefined ? Number(values.ttl) : undefined,
      context: values.context, verifierJwk: loadJson(values.key) as VerifierJwk,
    });
    if (values.out) {
      writeFileSync(values.out, JSON.stringify(issued.ticket, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify(issued.challenge, null, 2));
    } else {
      console.log(JSON.stringify({ challenge: issued.challenge, ticket: issued.ticket }, null, 2));
    }
    return;
  }
  if (command === "verify") {
    if (!values.key || !values.ticket || !values["response-file"]) throw new Error("verify requires --key --ticket --response-file");
    const receipt = verifyResponse({ ticket: loadJson(values.ticket) as Ticket, response: readFileSync(values["response-file"], "utf8").trim(), verifierJwk: loadJson(values.key) as VerifierJwk });
    if (values.out) writeFileSync(values.out, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
    else console.log(JSON.stringify(receipt, null, 2));
    return;
  }
  if (command === "check") {
    const result = checkReceipt(loadJson(positionals[0] ?? "") as Receipt);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  throw new Error(`unknown command: ${command}. ${usage}`);
}

if (import.meta.main) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "attest failed"); process.exitCode = 2; }
}
