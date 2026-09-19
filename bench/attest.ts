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
 * inside one time window; an optional subjectProof additionally binds the
 * response to a respondent-held Ed25519 key. It is not a liveness credential,
 * does not prove a model (or AI) produced the response, grants no authority,
 * and provides no durable replay protection — consumers should issue fresh
 * challenges.
 */
import { parseArgs } from "node:util";
import { generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes, sign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { poolForVersion, suiteVersion, type SuiteName } from "../ladder/mod.ts";
import { answerFormat, scoreAnswer, canonicalAnswer, MAX_ANSWER_LENGTH, type AnswerFormat, type Instance } from "../ladder/family.ts";
import { canonical, sha256 } from "./canon.ts";
import { holdoutCell, holdoutInstance, parsePool, type HoldoutCell, type HoldoutPool } from "./holdout.ts";

export { canonical };

export const ATTEST_PROTOCOL = "clankdar-attest-v1";
const COMMIT_DOMAIN = "clankdar/attest-seed/v1";
const SUBJECT_DOMAIN = "clankdar/subject/v1";
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
  /** Held-out cell marker (clankdar-holdout-v1): the instance replays only for checkers holding the committed pool. */
  heldout?: { poolKey: string };
  verifier: { keyId: string; publicKey: string };
}

export interface Ticket {
  challenge: Challenge;
  /** Verifier-side only until a receipt reveals it. */
  seed: number;
  /** Canonical expected answer, held by the verifier until reveal. */
  expected: string;
}

/**
 * A respondent's optional key proof: `publicKey` is a base64url Ed25519 JWK
 * `x` member (the same encoding as verifier keys) and `signature` is a
 * base64url Ed25519 signature over the challenge's subject transcript. It
 * binds the response to a key the respondent controls — never to a model,
 * a person, or an authority.
 */
export interface SubjectProof {
  publicKey: string;
  signature: string;
}

/** The signed body, serialized inside `Receipt.payload`. */
export interface ReceiptBody {
  kind: "receipt";
  challenge: Challenge;
  seed: number;
  expected: string;
  response: string;
  /** Optional respondent key proof, embedded inside the signed payload. */
  subjectProof?: SubjectProof;
  verdict: { pass: boolean; format: AnswerFormat; answeredAt: string };
}

export interface Receipt {
  protocol: typeof ATTEST_PROTOCOL;
  payload: string;
  signature: string;
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

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

/** Shape check for a subject proof; unknown members are ignored. */
export const isSubjectProof = (value: unknown): value is SubjectProof =>
  !!value && typeof value === "object" && typeof (value as SubjectProof).publicKey === "string" && typeof (value as SubjectProof).signature === "string";

/**
 * The domain-separated transcript a subject proof signs. Session-scoped when
 * the challenge carries `sessionId` — one proof then covers every challenge
 * minted under that gate session. Standalone challenges bind the proof to
 * the single `challengeId` + `nonce` instead.
 */
export const subjectTranscript = (challenge: Pick<Challenge, "challengeId" | "nonce" | "sessionId">, publicKey: string): string =>
  canonical(
    challenge.sessionId !== undefined
      ? [SUBJECT_DOMAIN, challenge.sessionId, publicKey]
      : [SUBJECT_DOMAIN, challenge.challengeId, challenge.nonce, publicKey],
  );

/** Mint a subject proof for a challenge with a respondent Ed25519 JWK (same shape as verifier keys). */
export function subjectProofFor(challenge: Pick<Challenge, "challengeId" | "nonce" | "sessionId">, respondentJwk: VerifierJwk): SubjectProof {
  const publicKey = publicKeyOf(respondentJwk);
  const signature = sign(null, Buffer.from(subjectTranscript(challenge, publicKey)), privateKey(respondentJwk));
  return { publicKey, signature: b64url(signature) };
}

/** Independently verify a subject proof against the challenge's transcript. */
export function checkSubjectProof(challenge: Pick<Challenge, "challengeId" | "nonce" | "sessionId">, proof: SubjectProof): boolean {
  try {
    return cryptoVerify(null, Buffer.from(subjectTranscript(challenge, proof.publicKey)), publicJwk(proof.publicKey), Buffer.from(proof.signature, "base64url"));
  } catch {
    return false;
  }
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
  /** Mint the cell from this holdout pool instead of the published stream (clankdar-holdout-v1). */
  holdoutPool?: HoldoutPool;
  verifierJwk: VerifierJwk;
  now?: Date;
}

/** Mint a sealed challenge plus the verifier-side ticket holding the seed. */
export function issueChallenge(opts: IssueOptions): { challenge: Challenge; ticket: Ticket; instance: Instance } {
  const version = suiteVersion(opts.suite);
  const family = poolForVersion(version).find((f) => f.name === opts.family);
  if (!family || !family.tiers.includes(opts.tier)) throw new Error(`unknown cell for suite ${opts.suite}: ${opts.family}:t${opts.tier}`);
  let holdCell: HoldoutCell | undefined;
  if (opts.holdoutPool !== undefined) {
    if (opts.holdoutPool.suite !== opts.suite) throw new Error("holdout pool is for a different suite");
    holdCell = holdoutCell(opts.holdoutPool, opts.family, opts.tier);
    if (!holdCell) throw new Error(`cell is not in the holdout pool: ${opts.family}:t${opts.tier}`);
  }
  const seed = opts.seed ?? randomBytes(4).readUInt32BE(0);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("seed must be a uint32");
  const ttl = opts.ttlSeconds ?? 300;
  if (!Number.isInteger(ttl) || ttl < 10 || ttl > 86_400) throw new Error("ttl must be 10..86400 seconds");
  if (opts.context !== undefined && (typeof opts.context !== "string" || opts.context.length > 256)) throw new Error("context must be a string up to 256 chars");
  if (opts.subject !== undefined && (typeof opts.subject !== "string" || !opts.subject.length || opts.subject.length > 256)) throw new Error("subject must be a nonempty string up to 256 chars");
  if (opts.sessionId !== undefined && (typeof opts.sessionId !== "string" || !/^gs_[A-Za-z0-9_-]{12}$/.test(opts.sessionId))) throw new Error("sessionId must be a gate session id");
  const publicKey = publicKeyOf(opts.verifierJwk);
  const instance = holdCell !== undefined ? holdoutInstance(opts.holdoutPool!, holdCell, seed) : family.generate(opts.tier, seed);
  const now = opts.now ?? new Date();
  const challenge: Challenge = {
    protocol: ATTEST_PROTOCOL, kind: "challenge", challengeId: `att_${b64url(randomBytes(9))}`,
    suiteVersion: version, family: family.name, tier: opts.tier, prompt: instance.prompt,
    seedCommit: "", nonce: b64url(randomBytes(12)), expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
    ...(opts.context !== undefined ? { context: opts.context } : {}),
    ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    ...(holdCell !== undefined ? { heldout: { poolKey: opts.holdoutPool!.poolKey } } : {}),
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
  /** Optional respondent key proof, verified against the challenge transcript before minting. */
  subjectProof?: SubjectProof;
  /** Pool that minted a held-out ticket; required when the challenge carries `heldout`. */
  pool?: HoldoutPool;
  verifierJwk: VerifierJwk;
  now?: Date;
}

/** Regenerate a ticket's instance from the published stream or the committed holdout pool. */
const instanceFor = (challenge: Challenge, seed: number, pool: HoldoutPool | undefined): Instance => {
  if (challenge.heldout !== undefined) {
    if (pool === undefined || pool.poolKey !== challenge.heldout.poolKey) throw new Error("ticket needs the matching holdout pool");
    const cell = holdoutCell(pool, challenge.family, challenge.tier);
    if (!cell) throw new Error("ticket cell is not in the holdout pool");
    return holdoutInstance(pool, cell, seed);
  }
  return poolForVersion(challenge.suiteVersion).find((f) => f.name === challenge.family)!.generate(challenge.tier, seed);
};

/** Rescore the response and sign a seed-revealing receipt. Expired tickets refuse. */
export function verifyResponse(opts: VerifyOptions): Receipt {
  const { challenge, seed, expected } = opts.ticket;
  const now = opts.now ?? new Date();
  if (challenge?.protocol !== ATTEST_PROTOCOL || challenge.kind !== "challenge") throw new Error("not an attestation challenge");
  if (!Number.isInteger(seed) || challenge.seedCommit !== seedCommit(challenge, seed)) throw new Error("ticket seed does not match the committed challenge");
  if (now.getTime() > Date.parse(challenge.expiresAt)) throw new Error("challenge expired");
  if (typeof opts.response !== "string" || opts.response.length > MAX_ANSWER_LENGTH) throw new Error("response missing or oversized");
  const instance = instanceFor(challenge, seed, opts.pool);
  if (instance.prompt !== challenge.prompt) throw new Error("challenge prompt does not regenerate from the committed seed");
  const format = answerFormat(challenge.family);
  if (canonicalAnswer(expected, format) !== expected || canonicalAnswer(instance.answer, format) !== expected) throw new Error("ticket answer does not match the regenerated instance");
  if (opts.subjectProof !== undefined) {
    if (!isSubjectProof(opts.subjectProof)) throw new Error("subject proof must be {publicKey, signature} strings");
    if (!checkSubjectProof(challenge, opts.subjectProof)) throw new Error("subject proof does not verify for this challenge");
  }
  const scored = scoreAnswer(instance.answer, opts.response, format);
  const body: ReceiptBody = {
    kind: "receipt", challenge, seed, expected,
    response: opts.response,
    ...(opts.subjectProof !== undefined ? { subjectProof: opts.subjectProof } : {}),
    verdict: { pass: scored.pass, format, answeredAt: now.toISOString() },
  };
  const signature = sign(null, Buffer.from(canonical(body)), privateKey(opts.verifierJwk));
  return { protocol: ATTEST_PROTOCOL, payload: canonical(body), signature: b64url(signature) };
}

export interface CheckResult {
  ok: boolean;
  verdict?: boolean;
  /** False when a held-out cell could not be replayed without its pool — signature and commitment still verified. */
  replayable?: boolean;
  reason?: string;
}

/**
 * Independently replay a receipt: signature over the payload bytes, seed
 * binding, instance regeneration, rescore, timing. Needs no trust beyond the
 * recorded episode. Held-out cells (`challenge.heldout`) replay only with
 * the committed pool; without it the result is `ok` with `replayable:false`
 * — the envelope verified, the score is issuer-claimed.
 */
export function checkReceipt(receipt: Receipt, opts?: { pool?: HoldoutPool }): CheckResult {
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
  let instance: Instance | undefined;
  if (challenge.heldout !== undefined) {
    if (typeof challenge.heldout !== "object" || typeof challenge.heldout.poolKey !== "string" || !/^[0-9a-f]{64}$/.test(challenge.heldout.poolKey)) return fail("malformed heldout marker");
    const pool = opts?.pool !== undefined && opts.pool.poolKey === challenge.heldout.poolKey ? opts.pool : undefined;
    if (pool !== undefined) {
      const cell = holdoutCell(pool, challenge.family, challenge.tier);
      if (cell === undefined) return fail("held-out cell is not in the committed pool");
      try {
        instance = holdoutInstance(pool, cell, seed);
      } catch (error) {
        return fail(`held-out instance does not regenerate: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    try {
      const family = poolForVersion(challenge.suiteVersion).find((f) => f.name === challenge.family);
      if (!family || !family.tiers.includes(challenge.tier)) return fail("unknown cell for the recorded suite version");
      instance = family.generate(challenge.tier, seed);
    } catch (error) {
      return fail(`instance does not regenerate: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const format = answerFormat(challenge.family);
  if (verdict.format !== format || canonicalAnswer(response, format) === null) return fail("response is not in the declared answer format");
  if (canonicalAnswer(expected, format) !== expected) return fail("recorded answer disagrees with regeneration");
  if (instance !== undefined) {
    if (instance.prompt !== challenge.prompt) return fail("recorded prompt disagrees with regeneration");
    if (canonicalAnswer(instance.answer, format) !== expected) return fail("recorded answer disagrees with regeneration");
    if (scoreAnswer(instance.answer, response, format).pass !== verdict.pass) return fail("verdict does not rescore");
  }
  if (Date.parse(verdict.answeredAt) > Date.parse(challenge.expiresAt)) return fail("answer is later than the challenge expiry");
  if (body.subjectProof !== undefined) {
    if (!isSubjectProof(body.subjectProof)) return fail("malformed subject proof");
    if (!checkSubjectProof(challenge, body.subjectProof)) return fail("subject proof does not verify");
  }
  return { ok: true, verdict: verdict.pass, ...(instance === undefined ? { replayable: false } : {}) };
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
      ticket: { type: "string" }, "response-file": { type: "string" }, "subject-key": { type: "string" },
      pool: { type: "string" }, holdout: { type: "string" }, help: { type: "boolean", short: "h" },
    },
    allowPositionals: true, strict: true,
  });
  const usage = "usage: attest keygen --out KEY.json | issue --key KEY.json --suite v2|frontier|agent --family NAME --tier N [--seed N] [--ttl SEC] [--context TEXT] [--holdout POOL.json] [--out TICKET.json] | verify --key KEY.json --ticket TICKET.json --response-file FILE [--subject-key KEY.json] [--pool POOL.json] [--out RECEIPT.json] | check RECEIPT.json [--pool POOL.json]";
  const loadPool = () => (values.pool !== undefined ? parsePool(loadJson(values.pool)) : undefined);
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
      holdoutPool: values.holdout !== undefined ? parsePool(loadJson(values.holdout)) : undefined,
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
    const ticket = loadJson(values.ticket) as Ticket;
    const subjectProof = values["subject-key"] !== undefined ? subjectProofFor(ticket.challenge, loadJson(values["subject-key"]) as VerifierJwk) : undefined;
    const receipt = verifyResponse({ ticket, response: readFileSync(values["response-file"], "utf8").trim(), subjectProof, pool: loadPool(), verifierJwk: loadJson(values.key) as VerifierJwk });
    if (values.out) writeFileSync(values.out, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
    else console.log(JSON.stringify(receipt, null, 2));
    return;
  }
  if (command === "check") {
    const result = checkReceipt(loadJson(positionals[0] ?? "") as Receipt, { pool: loadPool() });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  throw new Error(`unknown command: ${command}. ${usage}`);
}

if (import.meta.main) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "attest failed"); process.exitCode = 2; }
}
