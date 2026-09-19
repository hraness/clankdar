import { suiteVersion } from "../../ladder/mod.ts";
import { MAX_ANSWER_LENGTH } from "../../ladder/family.ts";
import { HOSTED_POLICIES, issueCheckSession, submitCheckSession, verifySessionSubject, type CheckSessionSecret, type HostedAdmission, type SubjectProof } from "./challenges.ts";
import { readBody } from "./http.ts";
import { issuerIdentity, type IssuerIdentity } from "./issuer.ts";
import { b64url, canonical, importActorKey, sha256, sha256Bytes, unb64url, verifyActorSignature } from "./protocol.ts";
import { openJson, sealJson } from "./seal.ts";
import type { Env } from "./types.ts";

const CHECK_ID = /^gs_[A-Za-z0-9_-]{12}$/;
const CHALLENGE_ID = /^att_[A-Za-z0-9_-]{12}$/;
const TICKET_PROTOCOL = "clankdar-check-ticket-v1";
const MAX_TICKET_CHARS = 65_536;
const MAX_BODY_BYTES = 131_072;
const MAX_RECEIPT_BYTES = 262_144;
const ISSUANCE_CAPACITY = 1024;
const PER_MINUTE = 60;
const encoder = new TextEncoder();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const receiptUrl = (id: string) => `/v1/checks/${id}`;
const resultKey = (id: string) => `checks/${id}.json`;
const ticketAad = (env: Env, issuer: IssuerIdentity, id: string) => canonical([TICKET_PROTOCOL, env.ENVIRONMENT, issuer.publicKey, id]);
const publicPolicy = (session: CheckSessionSecret) => {
  const { suite, cells, challenges, minPass, ttlSeconds } = session.policy;
  return { suite, cells, challenges, minPass, ttlSeconds };
};

class CheckError extends Error {
  constructor(readonly status: number, reason: string) { super(reason); }
}
const reject = (status: number, reason: string): never => { throw new CheckError(status, reason); };

async function body(req: Request, limit: number): Promise<Record<string, unknown>> {
  const bytes = await readBody(req, limit);
  if (!bytes) return reject(413, "request body exceeds its size or time limit");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return reject(400, "invalid body"); }
  return object(value) ? value : reject(400, "invalid body");
}

async function canonicalPublicKey(value: unknown): Promise<boolean> {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const raw = unb64url(value);
    if (raw.byteLength !== 32 || b64url(raw) !== value) return false;
    await importActorKey(value);
    return true;
  } catch { return false; }
}

async function authorized(req: Request, env: Env): Promise<boolean> {
  if (!env.REGISTRATION_TOKEN) return reject(503, "check issuance unavailable");
  const token = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  const [left, right] = await Promise.all([sha256Bytes(token), sha256Bytes(env.REGISTRATION_TOKEN)]);
  let different = 0;
  for (let i = 0; i < left.length; i++) different |= left[i] ^ right[i];
  return different === 0;
}

async function reserveIssuance(env: Env, now: Date): Promise<void> {
  const minute = Math.floor(now.getTime() / 60_000);
  // One atomic reservation. Fixed UTC-minute pacing and a lifetime ceiling
  // are shared by the staging invitation token. Failed issuance keeps its slot.
  const reserved = await env.REGISTRY.prepare(`
    UPDATE check_issuance_budget
    SET issued_total = issued_total + 1,
        minute_issued = CASE WHEN minute_started = ? THEN minute_issued + 1 ELSE 1 END,
        minute_started = ?
    WHERE singleton = 1 AND issued_total < ?
      AND (minute_started < ? OR (minute_started = ? AND minute_issued < ?))
    RETURNING issued_total
  `).bind(minute, minute, ISSUANCE_CAPACITY, minute, minute, PER_MINUTE).first();
  if (!reserved) reject(429, "staging check issuance capacity reached");
}

async function create(req: Request, env: Env, clock: () => Date): Promise<Response> {
  if (!await authorized(req, env)) return json({ ok: false, reason: "unauthorized" }, 401);
  const value = await body(req, 4096);
  if (Object.keys(value).some((key) => !["policyId", "context", "subjectPublicKey"].includes(key))) return reject(400, "unknown check option");
  const policyId = value.policyId === undefined ? "algal-floor-v1" : value.policyId;
  if (typeof policyId !== "string" || !HOSTED_POLICIES[policyId]) return reject(400, "unknown policy");
  if (value.context !== undefined && (typeof value.context !== "string" || !value.context.trim() || value.context.length > 256)) return reject(400, "context must be a nonempty string up to 256 characters");
  if (value.subjectPublicKey !== undefined && !await canonicalPublicKey(value.subjectPublicKey)) return reject(400, "subjectPublicKey must be a canonical Ed25519 public key");
  const issuer = await issuerIdentity(env.ISSUER_JWK, env.ENVIRONMENT);
  const policy = HOSTED_POLICIES[policyId];
  await reserveIssuance(env, clock());
  const now = clock();
  const issued = await issueCheckSession({ policy, issuer, now, expiresAt: new Date(now.getTime() + policy.ttlSeconds * 1000),
    ...(value.context !== undefined ? { context: value.context as string } : {}),
    ...(value.subjectPublicKey !== undefined ? { subject: value.subjectPublicKey as string, subjectPublicKey: value.subjectPublicKey as string } : {}) });
  const id = issued.secret.sessionId;
  const ticket = await sealJson({ protocol: TICKET_PROTOCOL, session: issued.secret }, ticketAad(env, issuer, id), env.SESSION_WRAP_KEY, env.ENVIRONMENT);
  if (ticket.length > MAX_TICKET_CHARS) return reject(503, "check ticket exceeds its size limit");
  return json({ ok: true, id, ticket, policyId, expiresAt: issued.secret.expiresAt, challenges: issued.challenges, receiptUrl: receiptUrl(id) }, 201);
}

/** AES-GCM authenticates the ticket; these checks reject schema/issuer drift. */
async function authenticateTicket(ticket: unknown, id: string, env: Env, issuer: IssuerIdentity): Promise<CheckSessionSecret> {
  if (typeof ticket !== "string" || ticket.length > MAX_TICKET_CHARS || !/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/.test(ticket)) return reject(401, "invalid check ticket");
  let envelope: unknown;
  try { envelope = await openJson<unknown>(ticket, ticketAad(env, issuer, id), env.SESSION_WRAP_KEY, env.ENVIRONMENT); }
  catch { return reject(401, "invalid check ticket"); }
  if (!object(envelope) || envelope.protocol !== TICKET_PROTOCOL || !object(envelope.session)) return reject(401, "invalid check ticket");
  const value = envelope.session;
  if (!object(value.policy) || typeof value.policy.id !== "string") return reject(401, "invalid check ticket");
  const policy = HOSTED_POLICIES[value.policy.id];
  if (!policy || canonical(value.policy) !== canonical(policy) || value.sessionId !== id) return reject(401, "invalid check ticket");
  const issuedAt = typeof value.issuedAt === "string" ? Date.parse(value.issuedAt) : NaN;
  const expiresAt = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : NaN;
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt - issuedAt !== policy.ttlSeconds * 1000 || new Date(issuedAt).toISOString() !== value.issuedAt || new Date(expiresAt).toISOString() !== value.expiresAt) return reject(401, "invalid check ticket");
  if (value.context !== undefined && (typeof value.context !== "string" || !value.context.trim() || value.context.length > 256)) return reject(401, "invalid check ticket");
  if (value.subjectPublicKey !== undefined && !await canonicalPublicKey(value.subjectPublicKey)) return reject(401, "invalid check ticket");
  if (value.subject !== value.subjectPublicKey || !Array.isArray(value.tickets) || value.tickets.length !== policy.challenges) return reject(401, "invalid check ticket");
  const ids = new Set<string>();
  for (const ticket of value.tickets) {
    if (!object(ticket) || !object(ticket.challenge) || typeof ticket.seed !== "number" || !Number.isSafeInteger(ticket.seed) || ticket.seed < 0 || ticket.seed > 0xffff_ffff || typeof ticket.expected !== "string" || ticket.expected.length > MAX_ANSWER_LENGTH) return reject(401, "invalid check ticket");
    const challenge = ticket.challenge;
    if (challenge.protocol !== "clankdar-attest-v1" || challenge.kind !== "challenge" || typeof challenge.challengeId !== "string" || !CHALLENGE_ID.test(challenge.challengeId) || ids.has(challenge.challengeId) || challenge.sessionId !== id || challenge.suiteVersion !== suiteVersion(policy.suite) || !policy.cells.includes(`${challenge.family}:t${challenge.tier}`) || typeof challenge.prompt !== "string" || !challenge.prompt || typeof challenge.seedCommit !== "string" || !/^[0-9a-f]{64}$/.test(challenge.seedCommit) || typeof challenge.nonce !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(challenge.nonce) || challenge.expiresAt !== value.expiresAt || challenge.subject !== value.subject || challenge.context !== value.context || !object(challenge.verifier) || challenge.verifier.publicKey !== issuer.publicKey || challenge.verifier.keyId !== issuer.keyId) return reject(401, "invalid check ticket");
    ids.add(challenge.challengeId);
  }
  return value as unknown as CheckSessionSecret;
}

async function proofFrom(value: unknown): Promise<SubjectProof | undefined> {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).some((key) => !["publicKey", "signature"].includes(key)) || !await canonicalPublicKey(value.publicKey) || typeof value.signature !== "string") return reject(401, "subject proof does not verify");
  return { publicKey: value.publicKey as string, signature: value.signature };
}

interface StoredReceipt {
  receipt: HostedAdmission;
  text: string;
  sha256: string;
  body: { sessionId: string; policy: unknown; challenges: unknown[]; context?: string; subject?: string; verdict: { pass: boolean; passed: number; required: number } };
}

async function decodeReceipt(text: string, id: string): Promise<StoredReceipt> {
  const receipt = JSON.parse(text) as HostedAdmission;
  if (!object(receipt) || receipt.protocol !== "clankdar-gate-v1" || typeof receipt.payload !== "string" || typeof receipt.signature !== "string" || canonical(receipt) !== text) throw new Error("stored receipt is malformed");
  const body = JSON.parse(receipt.payload);
  if (!object(body) || body.kind !== "admission" || body.sessionId !== id || !Array.isArray(body.challenges) || !body.challenges.length || body.challenges.length > 16 || !object(body.verdict) || typeof body.verdict.pass !== "boolean" || !Number.isSafeInteger(body.verdict.passed) || !Number.isSafeInteger(body.verdict.required) || canonical(body) !== receipt.payload) throw new Error("stored receipt is malformed");
  const publicKey = body.challenges[0]?.verifier?.publicKey;
  if (typeof publicKey !== "string" || !await verifyActorSignature(publicKey, body, receipt.signature)) throw new Error("stored receipt signature does not verify");
  return { receipt, text, sha256: await sha256(text), body: body as unknown as StoredReceipt["body"] };
}

async function stored(env: Env, id: string): Promise<StoredReceipt | null> {
  const result = await env.EVIDENCE.get(resultKey(id));
  if (!result) return null;
  if (result.size > MAX_RECEIPT_BYTES) throw new Error("stored receipt exceeds its size limit");
  return decodeReceipt(await result.text(), id);
}

function accepted(result: StoredReceipt, session: CheckSessionSecret, status: number): Response {
  // A random identifier collision must not recover another ticket's result.
  if (canonical(result.body.challenges) !== canonical(session.tickets.map((ticket) => ticket.challenge)) || canonical(result.body.policy) !== canonical(publicPolicy(session)) || result.body.context !== session.context || result.body.subject !== session.subject) return reject(409, "check identifier conflict");
  return json({ ok: true, id: session.sessionId, pass: result.body.verdict.pass, passed: result.body.verdict.passed, required: result.body.verdict.required,
    receiptUrl: receiptUrl(session.sessionId), sha256: result.sha256, receipt: result.receipt }, status);
}

async function submit(req: Request, env: Env, id: string, clock: () => Date): Promise<Response> {
  const value = await body(req, MAX_BODY_BYTES);
  if (Object.keys(value).some((key) => !["ticket", "responses", "subjectProof"].includes(key))) return reject(400, "unknown submission option");
  const issuer = await issuerIdentity(env.ISSUER_JWK, env.ENVIRONMENT);
  const session = await authenticateTicket(value.ticket, id, env, issuer);
  const proof = await proofFrom(value.subjectProof);
  if (!await verifySessionSubject(session, proof)) return reject(401, "subject proof does not verify");
  if (!object(value.responses) || Object.entries(value.responses).some(([key, response]) => !session.tickets.some((ticket) => ticket.challenge.challengeId === key) || typeof response !== "string" || response.length > MAX_ANSWER_LENGTH)) return reject(400, "responses must map this check's challenge IDs to bounded strings");
  // Recover a committed outcome even after expiry; an expired ticket cannot
  // produce a NEW outcome. Ticket authentication and requested key proof still apply.
  const existing = await stored(env, id);
  if (existing) return accepted(existing, session, 200);
  const now = clock();
  if (now.getTime() > Date.parse(session.expiresAt)) return reject(410, "check expired");
  const result = await submitCheckSession({ session, responses: value.responses as Record<string, string>, subjectProof: proof, issuer, now });
  const text = canonical(result.admission);
  if (encoder.encode(text).byteLength > MAX_RECEIPT_BYTES) return reject(413, "receipt exceeds its size limit");
  let committed: R2Object | null;
  try {
    committed = await env.EVIDENCE.put(resultKey(id), text, { onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" } });
  } catch {
    // A transport failure can mean the write succeeded but its acknowledgement
    // was lost. Reconcile against the authoritative key before asking for retry.
    const recovered = await stored(env, id);
    if (recovered) return accepted(recovered, session, 200);
    return json({ ok: false, reason: "receipt commit unavailable", retryable: true }, 503);
  }
  if (committed) return accepted(await decodeReceipt(text, id), session, 201);
  const winner = await stored(env, id);
  if (winner) return accepted(winner, session, 200);
  return json({ ok: false, reason: "receipt commit unavailable", retryable: true }, 503);
}

/** No actor or session database records: sealed tickets + one immutable R2 result. */
export async function handleCheckRequest(req: Request, env: Env, clock: () => Date = () => new Date()): Promise<Response> {
  try {
    const path = new URL(req.url).pathname;
    if (req.method === "POST" && path === "/v1/checks") return await create(req, env, clock);
    const match = /^\/v1\/checks\/(gs_[A-Za-z0-9_-]{12})(\/responses)?$/.exec(path);
    if (!match || !CHECK_ID.test(match[1])) return json({ ok: false, reason: "not found" }, 404);
    if (req.method === "POST" && match[2]) return await submit(req, env, match[1], clock);
    if (req.method === "GET" && !match[2]) {
      const receipt = await stored(env, match[1]);
      return receipt ? new Response(receipt.text, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=31536000, immutable", etag: `"${receipt.sha256}"` } })
        : json({ ok: false, reason: "no committed result" }, 404);
    }
    return json({ ok: false, reason: "not found" }, 404);
  } catch (error) {
    return error instanceof CheckError ? json({ ok: false, reason: error.message }, error.status) : json({ ok: false, reason: "check service unavailable" }, 503);
  }
}
