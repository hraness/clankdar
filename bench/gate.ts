#!/usr/bin/env bun
/**
 * clankdar-gate-v1 — admission sessions over sealed-seed attestation.
 *
 *   bun bench/gate.ts policy --suite frontier --cells automata:t6,knights:t5 --challenges 3 --min-pass 2 --ttl 300 [--out policy.json]
 *   bun bench/gate.ts issue --key verifier.json --policy policy.json [--subject agent-7 --context jobs-board] [--out session.json]
 *   bun bench/gate.ts submit --key verifier.json --session session.json --responses responses.json [--subject-key respondent.json] [--out admission.json]
 *   bun bench/gate.ts check admission.json
 *   bun bench/gate.ts serve --key verifier.json --policy policy.json --dir gate-state/ [--port 8787]
 *   bun bench/gate.ts probe --key verifier.json --policy policy.json --adapter openai:gpt-4.1 --rounds 3 [--execute --max-requests 200]
 *
 * A session mints N sealed challenges under one deadline and one session id.
 * A single submit consumes the session: each response is rescored, every
 * format-canonical response produces a receipt, and the verifier signs an
 * admission binding the complete challenge list, the receipts, and the
 * verdict (passed ≥ minPass). Anyone replays the admission without trusting
 * the issuer beyond the signed episode: signature, seed commitments,
 * regeneration, rescore, timing, completeness, and verdict arithmetic all
 * check independently.
 *
 * Scope: an admission attests that one session produced K passing responses
 * under one policy inside one window. It is capability evidence — never
 * identity, liveness, or authority. Challenges can be delegated, and a
 * verifier can always answer its own oracle, so relying parties should
 * issue their own challenges and treat foreign admissions as
 * issuer-claimed.
 */
import { parseArgs } from "node:util";
import { randomBytes, randomInt, verify as cryptoVerify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ATTEST_PROTOCOL, canonical, checkReceipt, isSubjectProof, issueChallenge, keyIdOf, publicJwk, publicKeyOf,
  signBody, subjectProofFor, verifyResponse, type Challenge, type Receipt, type SubjectProof, type Ticket, type VerifierJwk,
} from "./attest.ts";
import { poolForVersion, suiteVersion, type SuiteName } from "../ladder/mod.ts";
import { answerFormat, canonicalAnswer, MAX_ANSWER_LENGTH } from "../ladder/family.ts";
import { adapterByName, openai } from "./adapters.ts";
import type { Adapter } from "./adapter.ts";
import { integer, requestBudget } from "./options.ts";
import { GateStore } from "./store.ts";

export const GATE_PROTOCOL = "clankdar-gate-v1";
const SESSION_ID = /^gs_[A-Za-z0-9_-]{12}$/;
const CHALLENGE_ID = /^att_[A-Za-z0-9_-]{12}$/;
const MAX_CELLS = 64;
const MAX_CHALLENGES = 16;
const MAX_TTL = 3600;
const MAX_HTTP_BODY = 128 * 1024;

/** One gate floor: which cells, how many challenges, how many must pass, how long. */
export interface GatePolicy {
  suite: SuiteName;
  /** Cell ids as "family:tier", e.g. "registervm:t5". 1..64 distinct entries. */
  cells: string[];
  /** Challenges minted per session: 1..16, drawn from cells with replacement. */
  challenges: number;
  /** Passing responses required to admit: 1..challenges. */
  minPass: number;
  /** Uniform session deadline in seconds: 10..3600. */
  ttlSeconds: number;
}

/** Verifier-side session state: the secret twin of the published challenges. */
export interface GateSession {
  protocol: typeof GATE_PROTOCOL;
  kind: "session";
  sessionId: string;
  policy: GatePolicy;
  subject?: string;
  context?: string;
  issuedAt: string;
  /** Uniform deadline; identical to every challenge's expiresAt. */
  expiresAt: string;
  tickets: Ticket[];
}

/** The signed body inside `Admission.payload`. */
export interface AdmissionBody {
  kind: "admission";
  sessionId: string;
  policy: GatePolicy;
  subject?: string;
  context?: string;
  /** Complete session challenge list — completeness, not receipts, is the record. */
  challenges: Challenge[];
  /** One receipt per answered, format-canonical challenge. */
  receipts: Receipt[];
  verdict: { pass: boolean; passed: number; required: number; decidedAt: string };
}

export interface Admission {
  protocol: typeof GATE_PROTOCOL;
  payload: string;
  signature: string;
}

const cellOf = (cell: string): { family: string; tier: number } => {
  const match = /^([a-z0-9]+):t(\d+)$/.exec(cell)!;
  return { family: match[1], tier: Number(match[2]) };
};

/** Strictly parse and bound a gate policy; every cell must exist in the suite pool. */
export function parsePolicy(value: unknown): GatePolicy {
  const fail = (message: string): never => {
    throw new Error(`invalid gate policy: ${message}`);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
  const p = value as Record<string, unknown>;
  if (p.suite !== "v2" && p.suite !== "frontier" && p.suite !== "agent") fail("suite must be v2, frontier, or agent");
  if (!Array.isArray(p.cells) || !p.cells.length || p.cells.length > MAX_CELLS || p.cells.some((c) => typeof c !== "string")) fail("cells must be 1..64 distinct cell ids");
  const suite = p.suite as SuiteName;
  const cells = p.cells as string[];
  if (new Set(cells).size !== cells.length) fail("cells must be distinct");
  const pool = poolForVersion(suiteVersion(suite));
  for (const cell of cells) {
    const parsed = /^([a-z0-9]+):t(\d+)$/.exec(cell);
    const family = parsed && pool.find((f) => f.name === parsed[1]);
    if (!parsed || !family || !family.tiers.includes(Number(parsed[2]))) fail(`unknown cell for suite ${p.suite}: ${cell}`);
  }
  if (!Number.isInteger(p.challenges) || (p.challenges as number) < 1 || (p.challenges as number) > MAX_CHALLENGES) fail(`challenges must be 1..${MAX_CHALLENGES}`);
  if (!Number.isInteger(p.minPass) || (p.minPass as number) < 1 || (p.minPass as number) > (p.challenges as number)) fail("minPass must be 1..challenges");
  if (!Number.isInteger(p.ttlSeconds) || (p.ttlSeconds as number) < 10 || (p.ttlSeconds as number) > MAX_TTL) fail(`ttlSeconds must be 10..${MAX_TTL}`);
  return { suite, cells, challenges: p.challenges as number, minPass: p.minPass as number, ttlSeconds: p.ttlSeconds as number };
}

/**
 * Mint a session: `policy.challenges` sealed challenges drawn uniformly from
 * the policy cells (with replacement), all under one session id and one
 * deadline. `pick` and `seedBase` exist for deterministic tests.
 */
export function issueSession(opts: {
  policy: GatePolicy;
  subject?: string;
  context?: string;
  verifierJwk: VerifierJwk;
  now?: Date;
  pick?: (bound: number) => number;
  seedBase?: number;
}): { session: GateSession; challenges: Challenge[] } {
  const policy = parsePolicy(opts.policy);
  const now = opts.now ?? new Date();
  const sessionId = `gs_${randomBytes(9).toString("base64url")}`;
  const pick = opts.pick ?? ((bound: number) => randomInt(bound));
  const cells = policy.cells.map(cellOf);
  const tickets: Ticket[] = [];
  const challenges: Challenge[] = [];
  for (let i = 0; i < policy.challenges; i++) {
    const cell = cells[pick(cells.length)];
    const issued = issueChallenge({
      suite: policy.suite, family: cell.family, tier: cell.tier,
      seed: opts.seedBase !== undefined ? opts.seedBase + i : undefined,
      ttlSeconds: policy.ttlSeconds, context: opts.context, subject: opts.subject,
      sessionId, verifierJwk: opts.verifierJwk, now,
    });
    tickets.push(issued.ticket);
    challenges.push(issued.challenge);
  }
  const session: GateSession = {
    protocol: GATE_PROTOCOL, kind: "session", sessionId, policy,
    ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    ...(opts.context !== undefined ? { context: opts.context } : {}),
    issuedAt: now.toISOString(), expiresAt: challenges[0].expiresAt, tickets,
  };
  return { session, challenges };
}

/**
 * Consume a session into its decision. Each listed challenge may supply one
 * response; a missing or non-format-canonical response is a failed challenge
 * with no receipt (only canonical responses produce checkable receipts). The
 * issuer runs the independent checker on every minted receipt before signing
 * the admission.
 */
export function submitSession(opts: {
  session: GateSession;
  responses: Record<string, string>;
  /** Optional respondent key proof; session-scoped, so the same object embeds in every minted receipt. */
  subjectProof?: SubjectProof;
  verifierJwk: VerifierJwk;
  now?: Date;
}): { receipts: Receipt[]; admission: Admission } {
  const { session } = opts;
  if (session?.protocol !== GATE_PROTOCOL || session.kind !== "session") throw new Error("not a gate session");
  const now = opts.now ?? new Date();
  if (now.getTime() > Date.parse(session.expiresAt)) throw new Error("session expired");
  const tickets = new Map(session.tickets.map((t) => [t.challenge.challengeId, t]));
  for (const id of Object.keys(opts.responses)) {
    if (!tickets.has(id)) throw new Error(`response for unknown challenge ${id}`);
  }
  const receipts: Receipt[] = [];
  let passed = 0;
  for (const ticket of session.tickets) {
    const response = opts.responses[ticket.challenge.challengeId];
    if (typeof response !== "string" || canonicalAnswer(response, answerFormat(ticket.challenge.family)) === null) continue;
    const receipt = verifyResponse({ ticket, response, subjectProof: opts.subjectProof, verifierJwk: opts.verifierJwk, now });
    const replay = checkReceipt(receipt);
    if (!replay.ok) throw new Error(`minted receipt does not verify: ${replay.reason}`);
    receipts.push(receipt);
    if (replay.verdict) passed++;
  }
  const body: AdmissionBody = {
    kind: "admission", sessionId: session.sessionId, policy: session.policy,
    ...(session.subject !== undefined ? { subject: session.subject } : {}),
    ...(session.context !== undefined ? { context: session.context } : {}),
    challenges: session.tickets.map((t) => t.challenge), receipts,
    verdict: { pass: passed >= session.policy.minPass, passed, required: session.policy.minPass, decidedAt: now.toISOString() },
  };
  return { receipts, admission: { protocol: GATE_PROTOCOL, payload: canonical(body), signature: signBody(body, opts.verifierJwk) } };
}

export interface AdmissionCheck {
  ok: boolean;
  verdict?: boolean;
  passed?: number;
  reason?: string;
}

/**
 * Independently replay an admission: payload signature, then every embedded
 * receipt through `checkReceipt`, then session binding, policy coverage,
 * completeness, deadline, and verdict arithmetic. Trusts nothing beyond the
 * recorded episode.
 */
export function checkAdmission(admission: Admission): AdmissionCheck {
  const fail = (reason: string): AdmissionCheck => ({ ok: false, reason });
  if (admission?.protocol !== GATE_PROTOCOL || typeof admission.payload !== "string" || typeof admission.signature !== "string") return fail("not a gate admission");
  let body: AdmissionBody;
  try {
    body = JSON.parse(admission.payload);
  } catch {
    return fail("payload is not JSON");
  }
  if (body?.kind !== "admission" || typeof body.sessionId !== "string" || !SESSION_ID.test(body.sessionId)) return fail("malformed admission payload");
  let policy: GatePolicy;
  try {
    policy = parsePolicy(body.policy);
  } catch (error) {
    return fail(`invalid embedded policy: ${error instanceof Error ? error.message : String(error)}`);
  }
  const challenges = body.challenges;
  if (!Array.isArray(challenges) || challenges.length !== policy.challenges) return fail("challenge list does not cover the policy");
  const version = suiteVersion(policy.suite);
  const validCells = new Set(policy.cells);
  const byId = new Map<string, Challenge>();
  let publicKey = "";
  let expiresAt = "";
  for (const challenge of challenges) {
    if (challenge?.protocol !== ATTEST_PROTOCOL || challenge.kind !== "challenge") return fail("malformed challenge in admission");
    if (challenge.sessionId !== body.sessionId) return fail("challenge is not bound to this session");
    if (challenge.suiteVersion !== version) return fail("challenge suite disagrees with the policy");
    if (!validCells.has(`${challenge.family}:t${challenge.tier}`)) return fail("challenge cell is outside the policy");
    if (!expiresAt) expiresAt = challenge.expiresAt;
    else if (challenge.expiresAt !== expiresAt) return fail("session challenges do not share one deadline");
    if (!publicKey) publicKey = challenge.verifier?.publicKey ?? "";
    else if (challenge.verifier?.publicKey !== publicKey) return fail("session challenges mix verifier keys");
    if (keyIdOf(challenge.verifier?.publicKey ?? "") !== challenge.verifier?.keyId) return fail("verifier keyId does not match the public key");
    if ((challenge.subject ?? undefined) !== body.subject || (challenge.context ?? undefined) !== body.context) return fail("challenge binding disagrees with the admission");
    if (byId.has(challenge.challengeId)) return fail("duplicate challenge id");
    byId.set(challenge.challengeId, challenge);
  }
  let verified = false;
  try {
    verified = cryptoVerify(null, Buffer.from(admission.payload), publicJwk(publicKey), Buffer.from(admission.signature, "base64url"));
  } catch {
    verified = false;
  }
  if (!verified) return fail("signature does not verify");
  const receipts = body.receipts;
  if (!Array.isArray(receipts) || receipts.length > challenges.length) return fail("malformed receipts");
  const answered = new Set<string>();
  let subjectKey: string | undefined;
  let passed = 0;
  for (const receipt of receipts) {
    const replay = checkReceipt(receipt);
    if (!replay.ok) return fail(`embedded receipt does not verify: ${replay.reason}`);
    const receiptBody = JSON.parse(receipt.payload) as { challenge: Challenge; subjectProof?: SubjectProof };
    const receiptChallenge = receiptBody.challenge;
    const listed = receiptChallenge && byId.get(receiptChallenge.challengeId);
    if (!listed || canonical(listed) !== canonical(receiptChallenge)) return fail("receipt is not for a listed session challenge");
    if (answered.has(receiptChallenge.challengeId)) return fail("two receipts for one challenge");
    answered.add(receiptChallenge.challengeId);
    if (receiptBody.subjectProof !== undefined) {
      if (subjectKey === undefined) subjectKey = receiptBody.subjectProof.publicKey;
      else if (receiptBody.subjectProof.publicKey !== subjectKey) return fail("receipts mix subject keys");
    }
    if (replay.verdict) passed++;
  }
  const verdict = body.verdict;
  if (!verdict || verdict.passed !== passed || verdict.required !== policy.minPass || verdict.pass !== (passed >= policy.minPass)) return fail("verdict does not rescore");
  const decided = Date.parse(verdict.decidedAt);
  if (!Number.isFinite(decided) || decided > Date.parse(expiresAt)) return fail("decision is later than the session deadline");
  return { ok: true, verdict: verdict.pass, passed };
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function boundedJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (text.length > MAX_HTTP_BODY) return null;
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Serving-side pacing. `openTotal` and `issueWindow` are hard bounds — they
 * cap the ledger's live set and mint rate regardless of who asks.
 * `openPerSubject` is fairness: one subject claim (or the shared anonymous
 * bucket) cannot hold every open slot, but subjects are unauthenticated —
 * a sybil can rotate claims, so per-subject limits pace, never exclude.
 */
export interface GateRateLimits {
  /** Max live (issued, undecided, unexpired) sessions across the gate. */
  openTotal?: number;
  /** Max live sessions per subject claim; anonymous sessions share a bucket. */
  openPerSubject?: number;
  /** Max sessions minted per rolling `seconds` window across the gate. */
  issueWindow?: { max: number; seconds: number };
}

const parseRateLimits = (limits: GateRateLimits | undefined): GateRateLimits | undefined => {
  if (limits === undefined) return undefined;
  const positive = (value: number | undefined, name: string) => {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) throw new Error(`${name} must be a positive integer`);
  };
  positive(limits.openTotal, "openTotal");
  positive(limits.openPerSubject, "openPerSubject");
  if (limits.issueWindow !== undefined) {
    positive(limits.issueWindow.max, "issueWindow.max");
    positive(limits.issueWindow.seconds, "issueWindow.seconds");
  }
  return limits;
};

/**
 * The gate as an HTTP service. POST /sessions mints a session (tickets stay
 * server-side in the store); POST /sessions/:id/responses consumes it into a
 * signed admission; GET /receipts/:challengeId serves minted receipts;
 * GET /policy publishes the floor and verifier key. The check→decide
 * critical section is synchronous, so concurrent submits cannot double-spend
 * a session. Optional rateLimits bound session issuance (429).
 */
export function serveGate(opts: {
  policy: GatePolicy;
  verifierJwk: VerifierJwk;
  store: GateStore;
  rateLimits?: GateRateLimits;
  host?: string;
  port?: number;
}): { url: string; close: () => void } {
  const policy = parsePolicy(opts.policy);
  const rateLimits = parseRateLimits(opts.rateLimits);
  const publicKey = publicKeyOf(opts.verifierJwk);
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const err = (status: number, message: string) => json({ error: message }, status);
  const server = Bun.serve({
    hostname: opts.host ?? "127.0.0.1",
    port: opts.port ?? 8787,
    fetch: async (req) => {
      const { pathname } = new URL(req.url);
      if (req.method === "GET" && pathname === "/healthz") return json({ ok: true });
      if (req.method === "GET" && pathname === "/policy") return json({ protocol: GATE_PROTOCOL, policy, verifier: { keyId: keyIdOf(publicKey), publicKey } });
      const receiptMatch = new RegExp(`^/receipts/(${CHALLENGE_ID.source.slice(1, -1)})$`).exec(pathname);
      if (req.method === "GET" && receiptMatch) {
        const receipt = opts.store.receipt(receiptMatch[1]);
        return receipt ? json(receipt) : err(404, "no receipt for that challenge");
      }
      if (req.method === "POST" && pathname === "/sessions") {
        const body = await boundedJson(req);
        if (body === null) return err(400, "request body must be a JSON object up to 128 KiB");
        if (rateLimits !== undefined) {
          const nowMs = Date.now();
          const subject = body.subject === undefined ? "" : String(body.subject);
          if (rateLimits.openTotal !== undefined && opts.store.openSessions(nowMs).length >= rateLimits.openTotal) {
            return err(429, "gate at capacity; retry when open sessions drain");
          }
          if (rateLimits.openPerSubject !== undefined && opts.store.openSessions(nowMs, subject).length >= rateLimits.openPerSubject) {
            return err(429, "too many open sessions for this subject");
          }
          const window = rateLimits.issueWindow;
          if (window !== undefined && opts.store.issuedSince(nowMs - window.seconds * 1000).length >= window.max) {
            return err(429, "session issuance rate exceeded; retry later");
          }
        }
        try {
          const { session, challenges } = issueSession({
            policy, verifierJwk: opts.verifierJwk,
            subject: body.subject === undefined ? undefined : String(body.subject),
            context: body.context === undefined ? undefined : String(body.context),
          });
          opts.store.issueSession(session);
          return json({ sessionId: session.sessionId, expiresAt: session.expiresAt, challenges }, 201);
        } catch {
          return err(400, "session request rejected");
        }
      }
      const submitMatch = new RegExp(`^/sessions/(${SESSION_ID.source.slice(1, -1)})/responses$`).exec(pathname);
      if (req.method === "POST" && submitMatch) {
        const entry = opts.store.session(submitMatch[1]);
        if (!entry) return err(404, "unknown session");
        if (entry.decided) return err(409, "session already decided");
        if (Date.now() > Date.parse(entry.session.expiresAt)) return err(410, "session expired");
        const body = await boundedJson(req);
        if (body === null) return err(400, "request body must be a JSON object up to 128 KiB");
        const responses = body.responses;
        if (!responses || typeof responses !== "object" || Array.isArray(responses)) return err(400, "responses must map challenge ids to response strings");
        for (const [id, value] of Object.entries(responses)) {
          if (!CHALLENGE_ID.test(id)) return err(400, "malformed challenge id in responses");
          if (typeof value !== "string" || value.length > MAX_ANSWER_LENGTH) return err(400, "responses must be bounded strings");
        }
        if (body.subjectProof !== undefined && !isSubjectProof(body.subjectProof)) return err(400, "subjectProof must be {publicKey, signature} strings");
        try {
          const { receipts, admission } = submitSession({
            session: entry.session, responses: responses as Record<string, string>,
            subjectProof: body.subjectProof as SubjectProof | undefined, verifierJwk: opts.verifierJwk,
          });
          opts.store.decide(entry.session.sessionId, admission, receipts);
          return json({ admission, receipts });
        } catch {
          return err(400, "response submission rejected");
        }
      }
      return err(404, "not found");
    },
  });
  return { url: `http://${server.hostname}:${server.port}`, close: () => server.stop(true) };
}

/**
 * Drift probe: self-issue sessions to one adapter, submit its responses, and
 * keep the signed admissions as replayable score-band evidence. Unaided
 * suites only — the agent track requires recorded tool episodes.
 */
export async function probe(opts: {
  policy: GatePolicy;
  verifierJwk: VerifierJwk;
  adapter: Adapter;
  rounds: number;
  outDir?: string;
}): Promise<{ rounds: number; sessions: number; passed: number; admitted: number; admissions: Admission[] }> {
  const policy = parsePolicy(opts.policy);
  if (policy.suite === "agent") throw new Error("probe supports unaided suites (v2, frontier); the agent track needs recorded tool episodes");
  if (opts.outDir) mkdirSync(opts.outDir, { recursive: true, mode: 0o700 });
  const admissions: Admission[] = [];
  let passed = 0;
  let admitted = 0;
  for (let round = 0; round < opts.rounds; round++) {
    const { session, challenges } = issueSession({ policy, verifierJwk: opts.verifierJwk });
    const responses: Record<string, string> = {};
    for (const challenge of challenges) {
      const solved = await opts.adapter.solve({ family: challenge.family, tier: challenge.tier, prompt: challenge.prompt });
      responses[challenge.challengeId] = typeof solved === "string" ? solved : solved.text;
    }
    const { admission } = submitSession({ session, responses, verifierJwk: opts.verifierJwk });
    const verdict = (JSON.parse(admission.payload) as AdmissionBody).verdict;
    if (verdict.pass) admitted++;
    passed += verdict.passed;
    admissions.push(admission);
    if (opts.outDir) writeFileSync(join(opts.outDir, `admission-${String(round + 1).padStart(3, "0")}.json`), JSON.stringify(admission, null, 2) + "\n", { flag: "wx" });
  }
  return { rounds: opts.rounds, sessions: opts.rounds * policy.challenges, passed, admitted, admissions };
}

function loadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${message(error)}`);
  }
}

const USAGE = `usage: gate <command>
  policy --suite v2|frontier|agent --cells f:t1,g:t2 --challenges N --min-pass M --ttl SEC [--out policy.json]
  issue --key K --policy P [--subject S] [--context C] [--seed N] [--out session.json]
  submit --key K --session S --responses R.json [--subject-key KEY.json] [--out admission.json]
  check ADMISSION.json
  serve --key K --policy P --dir STATE [--host H] [--port N] [--open-total N] [--open-per-subject N] [--issue-window MAX:SEC]
  probe --key K --policy P --adapter A --rounds N [--out DIR] [--execute --max-requests N --max-tokens N --timeout-ms N]`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      key: { type: "string" }, out: { type: "string" }, policy: { type: "string" }, session: { type: "string" },
      suite: { type: "string" }, cells: { type: "string" }, challenges: { type: "string" }, "min-pass": { type: "string" },
      ttl: { type: "string" }, subject: { type: "string" }, context: { type: "string" }, seed: { type: "string" },
      responses: { type: "string" }, "subject-key": { type: "string" }, dir: { type: "string" }, host: { type: "string" }, port: { type: "string" },
      adapter: { type: "string" }, rounds: { type: "string" },
      "open-total": { type: "string" }, "open-per-subject": { type: "string" }, "issue-window": { type: "string" },
      execute: { type: "boolean" }, "max-requests": { type: "string" }, "max-tokens": { type: "string" }, "timeout-ms": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true, strict: true,
  });
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  const need = (...names: (string | undefined)[]) => {
    if (names.some((n) => n === undefined)) throw new Error(`${command} requires more options.\n${USAGE}`);
  };
  const policy = () => parsePolicy(loadJson(values.policy!));

  if (command === "policy") {
    need(values.suite, values.cells, values.challenges, values["min-pass"], values.ttl);
    const built = parsePolicy({
      suite: values.suite, cells: values.cells!.split(",").map((c) => c.trim()),
      challenges: Number(values.challenges), minPass: Number(values["min-pass"]), ttlSeconds: Number(values.ttl),
    });
    if (values.out) writeFileSync(values.out, JSON.stringify(built, null, 2) + "\n", { flag: "wx" });
    else console.log(JSON.stringify(built, null, 2));
    return;
  }
  if (command === "issue") {
    need(values.key, values.policy);
    const { session, challenges } = issueSession({
      policy: policy(), verifierJwk: loadJson(values.key!) as VerifierJwk,
      subject: values.subject, context: values.context,
      seedBase: values.seed !== undefined ? Number(values.seed) : undefined,
    });
    if (values.out) {
      writeFileSync(values.out, JSON.stringify(session, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ sessionId: session.sessionId, expiresAt: session.expiresAt, challenges }, null, 2));
    } else {
      console.log(JSON.stringify({ session, challenges }, null, 2));
    }
    return;
  }
  if (command === "submit") {
    need(values.key, values.session, values.responses);
    const session = loadJson(values.session!) as GateSession;
    const responses = loadJson(values.responses!) as Record<string, string>;
    if (values["subject-key"] !== undefined && !session.tickets?.length) throw new Error("session has no challenges to bind a subject proof to");
    const subjectProof = values["subject-key"] !== undefined ? subjectProofFor(session.tickets[0].challenge, loadJson(values["subject-key"]) as VerifierJwk) : undefined;
    const { receipts, admission } = submitSession({
      session, responses, subjectProof, verifierJwk: loadJson(values.key!) as VerifierJwk,
    });
    if (values.out) writeFileSync(values.out, JSON.stringify({ admission, receipts }, null, 2) + "\n", { flag: "wx" });
    else console.log(JSON.stringify({ admission, receipts }, null, 2));
    return;
  }
  if (command === "check") {
    const result = checkAdmission(loadJson(positionals[0] ?? "") as Admission);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (command === "serve") {
    need(values.key, values.policy, values.dir);
    const rateLimits: GateRateLimits = {};
    if (values["open-total"] !== undefined) rateLimits.openTotal = integer(values["open-total"], 1_000_000);
    if (values["open-per-subject"] !== undefined) rateLimits.openPerSubject = integer(values["open-per-subject"], 1_000_000);
    if (values["issue-window"] !== undefined) {
      const [max, seconds] = values["issue-window"].split(":");
      if (max === undefined || seconds === undefined) throw new Error("--issue-window expects MAX:SECONDS");
      rateLimits.issueWindow = { max: integer(max, 1_000_000), seconds: integer(seconds, 31_536_000) };
    }
    const store = GateStore.open(values.dir!);
    const gate = serveGate({
      policy: policy(), verifierJwk: loadJson(values.key!) as VerifierJwk, store,
      rateLimits: Object.keys(rateLimits).length ? rateLimits : undefined,
      host: values.host, port: values.port !== undefined ? integer(values.port, 65535) : undefined,
    });
    console.error(`clankdar-gate listening at ${gate.url} (policy: ${policy().challenges} challenges, ${policy().minPass} required, ${policy().ttlSeconds}s)`);
    return;
  }
  if (command === "probe") {
    need(values.key, values.policy, values.adapter, values.rounds);
    const rounds = integer(values.rounds!, 256);
    const p = policy();
    const remote = values.adapter!.startsWith("openai:");
    const budget = values["max-requests"] ? requestBudget(integer(values["max-requests"]!, 30_000)) : undefined;
    const adapter = remote
      ? openai({
          model: values.adapter!.slice(7), maxTokens: integer(values["max-tokens"] ?? "4096", 32_768),
          timeoutMs: integer(values["timeout-ms"] ?? "120000", 600_000), beforeRequest: budget?.beforeRequest,
        })
      : adapterByName(values.adapter!);
    if (remote && !values.execute) {
      console.log(JSON.stringify({ dryRun: true, adapter: values.adapter, rounds, challengesPerSession: p.challenges, maximumRequests: p.challenges * rounds * 3 }, null, 2));
      return;
    }
    if (remote && (!budget || budget.used() + p.challenges * rounds > integer(values["max-requests"]!, 30_000))) throw new Error("--execute requires --max-requests at least challenges × rounds");
    const result = await probe({ policy: p, verifierJwk: loadJson(values.key!) as VerifierJwk, adapter, rounds, outDir: values.out });
    console.error(`${adapter.name}: ${result.admitted}/${result.rounds} sessions admitted, ${result.passed}/${result.sessions} challenges passed`);
    console.log(JSON.stringify({ adapter: adapter.name, rounds: result.rounds, challenges: result.sessions, passed: result.passed, admitted: result.admitted }, null, 2));
    return;
  }
  throw new Error(`unknown command: ${command}.\n${USAGE}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(message(error));
    process.exitCode = 2;
  }
}
