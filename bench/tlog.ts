#!/usr/bin/env bun
/**
 * clankdar-tlog-v1 — a signed transparency log over gate issuance.
 *
 *   bun bench/tlog.ts build --dir gate-state/ --key verifier.json [--out tlog.json]
 *   bun bench/tlog.ts check tlog.json
 *   bun bench/tlog.ts prove tlog.json --session gs_xxx | --from-count N
 *   bun bench/tlog.ts check-proof proof.json --old-head head.json | --old-tip HEX --old-count N
 *   bun bench/tlog.ts admit tlog.json admission.json [--pool pool.json]
 *   bun bench/tlog.ts witness --heads heads.jsonl tlog.json
 *   bun bench/tlog.ts equivocate --heads heads.jsonl
 *   bun bench/tlog.ts compare log-a.json log-b.json
 *   bun bench/tlog.ts witness-serve --heads heads.jsonl [--port 8790] [--providers providers.json] [--poll-ms N]
 *
 * A derived view over the gate ledger (bench/store.ts appends one JSONL
 * record per session issuance and per decision). Every record becomes a
 * hash-chained entry — `digest` over the verbatim record, `prev` over the
 * previous entry hash — and the issuer signs the log head like a CT signed
 * tree head. Anyone recomputes the chain and replays the signature, so
 * issued sessions and decisions are enumerable: an admission whose
 * sessionId never reached the log is issuer-claimed only.
 *
 * Scope: the log binds this issuer's history under its own key. It does not
 * prevent self-minting — a verifier can always answer its own oracle — and
 * a single log cannot detect a fork by itself. Witnessed heads can:
 * `witness` records every signed head an operator sees in an append-only
 * heads.jsonl registry, and `equivocate` compares heads under each issuer
 * key. Two heads at the same count with different tips — or one tip signed
 * at two counts — are certain forks; a count that regresses in issue order
 * is only a warning, since issue timestamps are issuer-controlled. Heads
 * still have to reach a common witness to be compared: `witness-serve`
 * implements explicit provider-neutral intake and can poll configured
 * providers' `/tlog/head` endpoints on an interval, but provider
 * discovery, gossip, witnessed co-signing, and external anchoring remain
 * future work.
 * `compare` decides different-length forks when both full logs are present;
 * the head registry alone cannot. `prove --from-count`/`check-proof` cover
 * the cheap direction for a client that pinned an old head: a linear suffix
 * proof that a new, larger log extends the pinned one — O(new−old) entries,
 * not Merkle-logarithmic, since the chain is a linear hash chain by design.
 */
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  canonical, keyIdOf, publicKeyOf, signBody, verifyBodySignature,
  type Receipt, type VerifierJwk,
} from "./attest.ts";
import { checkAdmission, type Admission, type AdmissionBody, type GateSession } from "./gate.ts";
import { parsePool, type HoldoutPool } from "./holdout.ts";

export const TLOG_PROTOCOL = "clankdar-tlog-v1";
/** The ledger file `bench/store.ts` appends to inside a gate state dir. */
const LEDGER_NAME = "gate-state.jsonl";
/** Chain genesis: the first entry's `prev`. */
const GENESIS = "0".repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;

/** Ledger record shapes — identical to the private records in bench/store.ts. */
interface SessionRecord {
  type: "session";
  session: GateSession;
}

interface DecisionRecord {
  type: "decision";
  sessionId: string;
  admission: Admission;
  receipts: Receipt[];
}

type LedgerRecord = SessionRecord | DecisionRecord;

/** The hashed body of one entry — the fields `entryHash` commits to. */
export interface TlogEntry {
  index: number;
  type: "session" | "decision";
  sessionId: string;
  /** SHA-256 hex over `canonical()` of the verbatim ledger record. */
  digest: string;
  /** Previous entry's `entryHash`; the genesis entry uses 64 zeroes. */
  prev: string;
}

export interface TlogHashedEntry extends TlogEntry {
  /** SHA-256 hex over `canonical()` of the entry body (excluding entryHash). */
  entryHash: string;
}

/** Signed log head — the transparency-log analogue of a CT signed tree head. */
export interface TlogHead {
  protocol: typeof TLOG_PROTOCOL;
  kind: "head";
  /** Number of entries this head commits to. */
  count: number;
  /** `entryHash` of the last entry (64 zeroes on an empty log). */
  head: string;
  issuedAt: string;
  verifier: { keyId: string; publicKey: string };
  /** Base64url Ed25519 over `canonical()` of the head excluding `signature`. */
  signature: string;
}

export interface TransparencyLog {
  head: TlogHead;
  entries: TlogHashedEntry[];
}

const sha256hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** The canonical entry body `entryHash` covers — `entryHash` itself excluded. */
const entryHashOf = (entry: TlogEntry): string =>
  sha256hex(canonical({ index: entry.index, type: entry.type, sessionId: entry.sessionId, digest: entry.digest, prev: entry.prev }));

/** The canonical head body `signature` covers — `signature` itself excluded. */
const headBody = (head: TlogHead) => ({
  protocol: head.protocol, kind: head.kind, count: head.count,
  head: head.head, issuedAt: head.issuedAt, verifier: head.verifier,
});

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function boundedText(message_: Request | Response, maxBytes: number): Promise<string | null> {
  const declared = message_.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) return null;
  if (!message_.body) return "";
  const reader = message_.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Read and validate a gate ledger. Same replay rules as `GateStore.open`:
 * a torn final line is dropped, mid-log corruption is fatal, session ids are
 * unique, and a decision must name a known, still-open session.
 */
export function readLedger(dir: string): LedgerRecord[] {
  const path = join(dir, LEDGER_NAME);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${path}: ${message(error)}`);
  }
  const lines = text.split("\n").filter((line) => line.length > 0);
  const records: LedgerRecord[] = [];
  const issued = new Set<string>();
  const decided = new Set<string>();
  lines.forEach((line, index) => {
    let record: LedgerRecord;
    try {
      record = JSON.parse(line) as LedgerRecord;
    } catch {
      if (index === lines.length - 1) return; // torn tail from a crashed append
      throw new Error(`gate ledger is corrupt at record ${index + 1}`);
    }
    if (record?.type === "session") {
      const sessionId = record.session?.sessionId;
      if (typeof sessionId !== "string" || issued.has(sessionId)) {
        throw new Error(`gate ledger has a duplicate or malformed session at record ${index + 1}`);
      }
      issued.add(sessionId);
    } else if (record?.type === "decision") {
      const sessionId = record.sessionId;
      if (typeof sessionId !== "string" || !issued.has(sessionId) || decided.has(sessionId)) {
        throw new Error(`gate ledger has a decision for an unknown or decided session at record ${index + 1}`);
      }
      decided.add(sessionId);
    } else {
      throw new Error(`gate ledger has an unknown record type at record ${index + 1}`);
    }
    records.push(record);
  });
  return records;
}

/** Chain ledger records into entries: digest of the record, prev of the chain. */
export function entriesFor(records: LedgerRecord[]): TlogHashedEntry[] {
  const entries: TlogHashedEntry[] = [];
  let prev = GENESIS;
  records.forEach((record, index) => {
    const sessionId = record.type === "session" ? record.session.sessionId : record.sessionId;
    const entry: TlogEntry = { index, type: record.type, sessionId, digest: sha256hex(canonical(record)), prev };
    const entryHash = entryHashOf(entry);
    entries.push({ ...entry, entryHash });
    prev = entryHash;
  });
  return entries;
}

/** Sign a head committing to `count` entries ending at `head` (entryHash). */
export function signHead(count: number, head: string, verifierJwk: VerifierJwk, now?: Date): TlogHead {
  const publicKey = publicKeyOf(verifierJwk);
  const unsigned: Omit<TlogHead, "signature"> = {
    protocol: TLOG_PROTOCOL, kind: "head", count, head,
    issuedAt: (now ?? new Date()).toISOString(),
    verifier: { keyId: keyIdOf(publicKey), publicKey },
  };
  return { ...unsigned, signature: signBody(unsigned, verifierJwk) };
}

/** Build the full derived log for a gate state dir and sign its head. */
export function buildLog(opts: { dir: string; verifierJwk: VerifierJwk; now?: Date }): TransparencyLog {
  const entries = entriesFor(readLedger(opts.dir));
  const head = signHead(entries.length, entries.length ? entries[entries.length - 1].entryHash : GENESIS, opts.verifierJwk, opts.now);
  return { head, entries };
}

export interface LogCheck {
  ok: boolean;
  count?: number;
  reason?: string;
}

/**
 * Independently replay a transparency log: recompute every entryHash, walk
 * the chain, recount, and re-verify the head signature and keyId. Entry
 * order must also satisfy ledger semantics — a session is issued once and a
 * decision names an issued, still-open session — so a well-formed log can
 * only derive from a well-formed ledger.
 */
export function checkLog(log: unknown): LogCheck {
  const fail = (reason: string): LogCheck => ({ ok: false, reason });
  if (!log || typeof log !== "object" || Array.isArray(log)) return fail("not a transparency log");
  const { head, entries } = log as TransparencyLog;
  if (!Array.isArray(entries)) return fail("entries is not an array");
  const issued = new Set<string>();
  const decided = new Set<string>();
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") return fail(`entry ${i} is malformed`);
    if (entry.index !== i) return fail(`entry ${i} has the wrong index`);
    if (entry.type !== "session" && entry.type !== "decision") return fail(`entry ${i} has an unknown type`);
    if (typeof entry.sessionId !== "string" || !entry.sessionId.length) return fail(`entry ${i} has no sessionId`);
    if (typeof entry.digest !== "string" || !HEX64.test(entry.digest)) return fail(`entry ${i} has a malformed digest`);
    if (typeof entry.prev !== "string" || !HEX64.test(entry.prev)) return fail(`entry ${i} has a malformed prev`);
    if (typeof entry.entryHash !== "string" || !HEX64.test(entry.entryHash)) return fail(`entry ${i} has a malformed entryHash`);
    if (entry.prev !== prev) return fail(`entry ${i} breaks the chain`);
    if (entryHashOf(entry) !== entry.entryHash) return fail(`entry ${i} hash does not recompute`);
    if (entry.type === "session") {
      if (issued.has(entry.sessionId)) return fail(`entry ${i} re-issues a session`);
      issued.add(entry.sessionId);
    } else {
      if (!issued.has(entry.sessionId) || decided.has(entry.sessionId)) return fail(`entry ${i} decides an unknown or decided session`);
      decided.add(entry.sessionId);
    }
    prev = entry.entryHash;
  }
  if (!head || typeof head !== "object") return fail("head is missing");
  if (head.protocol !== TLOG_PROTOCOL || head.kind !== "head") return fail("head is not a tlog head");
  if (head.count !== entries.length) return fail("head count does not match entries");
  if (head.head !== prev) return fail("head does not match the last entry");
  if (typeof head.issuedAt !== "string" || !Number.isFinite(Date.parse(head.issuedAt))) return fail("head issuedAt is malformed");
  const publicKey = head.verifier?.publicKey;
  if (typeof publicKey !== "string" || keyIdOf(publicKey) !== head.verifier?.keyId) return fail("verifier keyId does not match the public key");
  if (typeof head.signature !== "string" || !verifyBodySignature(headBody(head), head.signature, publicKey)) return fail("head signature does not verify");
  return { ok: true, count: entries.length };
}

export interface SessionProof {
  sessionId: string;
  /** Index of the session-issuance entry. */
  sessionIndex: number;
  /** Index of the decision entry, or null while the session is undecided. */
  decisionIndex: number | null;
  /** The signed head the indexes are read under. */
  head: TlogHead;
}

/**
 * Inclusion evidence for one session: the log must check out first, then the
 * session's issuance index and decision index are reported under the signed
 * head. A third party runs `checkLog`, then this proof, and knows the
 * session was issued and its decision logged.
 */
export function proveSession(log: TransparencyLog, sessionId: string): SessionProof {
  const check = checkLog(log);
  if (!check.ok) throw new Error(`transparency log failed check: ${check.reason}`);
  const sessionIndex = log.entries.findIndex((entry) => entry.type === "session" && entry.sessionId === sessionId);
  if (sessionIndex < 0) throw new Error(`session ${sessionId} is not in the log`);
  const decisionIndex = log.entries.findIndex((entry) => entry.type === "decision" && entry.sessionId === sessionId);
  return { sessionId, sessionIndex, decisionIndex: decisionIndex < 0 ? null : decisionIndex, head: log.head };
}

export interface AdmittedCheck {
  ok: boolean;
  verdict?: boolean;
  passed?: number;
  /** Held-out receipts whose scores remain issuer-claimed without a disclosed pool. */
  unreplayed?: number;
  reason?: string;
}

/**
 * Combined check: the admission must pass `checkAdmission` on its own AND
 * its sessionId must have both a session entry and a decision entry in a
 * log that itself verifies. This is the portable-badge test — a valid
 * admission with no logged session is issuer-claimed only. A disclosed
 * holdout pool upgrades matching held-out scores from issuer-claimed to
 * replayed; without it, `unreplayed` is preserved in every result.
 */
export function checkLoggedAdmission(
  log: TransparencyLog,
  admission: Admission,
  opts?: { pool?: HoldoutPool },
): AdmittedCheck {
  const result = checkAdmission(admission, opts);
  if (!result.ok) return { ok: false, reason: result.reason };
  const replay = {
    verdict: result.verdict,
    passed: result.passed,
    ...(result.unreplayed !== undefined ? { unreplayed: result.unreplayed } : {}),
  };
  const body = JSON.parse(admission.payload) as AdmissionBody;
  const check = checkLog(log);
  if (!check.ok) return { ok: false, ...replay, reason: `transparency log failed check: ${check.reason}` };
  const hasSession = log.entries.some((entry) => entry.type === "session" && entry.sessionId === body.sessionId);
  if (!hasSession) return { ok: false, ...replay, reason: `session ${body.sessionId} is not in the transparency log` };
  const hasDecision = log.entries.some((entry) => entry.type === "decision" && entry.sessionId === body.sessionId);
  if (!hasDecision) return { ok: false, ...replay, reason: `session ${body.sessionId} has no logged decision` };
  return { ok: true, ...replay };
}

/** Maximum lines a heads registry may hold — a corrupt registry is fatal, not unbounded. */
export const HEADS_MAX_LINES = 1_000_000;

/**
 * Shape-and-signature check for a witnessed head: a standalone head has no
 * entries to match against, so this is the head half of `checkLog` —
 * protocol, count, tip, timestamp, verifier keyId, and the signature over
 * the head body.
 */
export function isSignedHead(value: unknown): value is TlogHead {
  const head = value as TlogHead;
  if (!head || typeof head !== "object" || Array.isArray(head)) return false;
  if (head.protocol !== TLOG_PROTOCOL || head.kind !== "head") return false;
  if (!Number.isSafeInteger(head.count) || head.count < 0) return false;
  if (typeof head.head !== "string" || !HEX64.test(head.head)) return false;
  if (typeof head.issuedAt !== "string" || !Number.isFinite(Date.parse(head.issuedAt))) return false;
  const publicKey = head.verifier?.publicKey;
  if (typeof publicKey !== "string" || keyIdOf(publicKey) !== head.verifier?.keyId) return false;
  return typeof head.signature === "string" && verifyBodySignature(headBody(head), head.signature, publicKey);
}

const normalizedHead = (head: TlogHead): TlogHead => ({
  protocol: head.protocol,
  kind: head.kind,
  count: head.count,
  head: head.head,
  issuedAt: head.issuedAt,
  verifier: { keyId: head.verifier.keyId, publicKey: head.verifier.publicKey },
  signature: head.signature,
});

/**
 * Read and validate a heads registry: one signed `TlogHead` per JSONL line,
 * indexed by `verifier.keyId`. Same replay rules as
 * `readLedger` — a torn final line is dropped, while mid-file corruption
 * or a line that parses but fails `isSignedHead` is fatal (a recorded
 * head is evidence; an unverifiable one is corruption). A missing file is
 * an empty registry.
 */
export function readHeads(path: string, maxLines = HEADS_MAX_LINES): TlogHead[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`cannot read ${path}: ${message(error)}`);
  }
  const lines = text.split("\n").filter((line) => line.length > 0);
  if (lines.length > maxLines) throw new Error(`heads registry exceeds ${maxLines} lines`);
  const heads: TlogHead[] = [];
  lines.forEach((line, index) => {
    let head: TlogHead;
    try {
      head = JSON.parse(line) as TlogHead;
    } catch {
      if (index === lines.length - 1) return; // torn tail from a crashed append
      throw new Error(`heads registry is corrupt at line ${index + 1}`);
    }
    if (!isSignedHead(head)) throw new Error(`heads registry has an invalid head at line ${index + 1}`);
    heads.push(head);
  });
  return heads;
}

export interface WitnessResult {
  ok: boolean;
  /** False when the identical head was already in the registry. */
  recorded: boolean;
  keyId?: string;
  count?: number;
  head?: string;
  /** Total heads in the registry after the call. */
  witnessed?: number;
  reason?: string;
}

/**
 * Witness a log's signed head into a heads registry. The log must pass
 * `checkLog` first — only a verified head is worth recording. The registry
 * is append-only evidence (created 0644 like a public-adjacent store);
 * re-witnessing an identical head is a no-op, not an error.
 */
export function witnessHead(headsPath: string, log: unknown): WitnessResult {
  const check = checkLog(log);
  if (!check.ok) return { ok: false, recorded: false, reason: `transparency log failed check: ${check.reason}` };
  const head = (log as TransparencyLog).head;
  const { recorded, witnessed } = appendHead(headsPath, head);
  return { ok: true, recorded, keyId: head.verifier.keyId, count: head.count, head: head.head, witnessed };
}

/** Append one signed head to the registry; an identical signed claim is a no-op. */
function appendHead(headsPath: string, head: TlogHead): { recorded: boolean; witnessed: number } {
  mkdirSync(dirname(headsPath), { recursive: true });
  const heads = readHeads(headsPath);
  const normalized = normalizedHead(head);
  const body = canonical(normalized);
  if (heads.some((recorded) => canonical(normalizedHead(recorded)) === body)) {
    return { recorded: false, witnessed: heads.length };
  }
  const fd = openSync(headsPath, "a", 0o644);
  try {
    writeSync(fd, JSON.stringify(normalized) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { recorded: true, witnessed: heads.length + 1 };
}

/** A pair of recorded heads that conflict (a fork) or merely warn (a regression). */
export interface HeadPair {
  keyId: string;
  conflict: [TlogHead, TlogHead];
  reason: string;
}

export interface EquivocationReport {
  ok: boolean;
  /** Heads examined across every keyId in the registry. */
  checked: number;
  /** On a proven fork: the issuer keyId, the two conflicting signed heads, and why. */
  keyId?: string;
  conflict?: [TlogHead, TlogHead];
  reason?: string;
  /** Soft findings — issuer-timestamped, never an exit-2 finding on their own. */
  warnings?: HeadPair[];
}

/**
 * Compare witnessed heads for equivocation. Two findings are certain —
 * the issuer's own signatures contradict each other:
 *
 * - **same count, different tip**: two equal-length chains cannot end at
 *   different `entryHash` values, so the heads cannot both describe real
 *   logs;
 * - **same tip, different count**: an `entryHash` commits to its index,
 *   so one tip cannot close both a count-4 and a count-6 chain.
 *
 * A `count` that decreases in `issuedAt` order is only a warning
 * (`"head counts regress"`): issue timestamps are issuer-controlled, so a
 * regression is soft evidence. Whether a shorter head is an ancestor of a
 * longer one cannot be decided from heads alone — the registry stores
 * heads, not entries — so different-count pairs with different tips are
 * undecidable here and unreported. When a verifier holds both published
 * logs, `compareLogs` decides that case by walking the chains.
 */
export function findEquivocation(heads: TlogHead[]): EquivocationReport {
  const byKey = new Map<string, TlogHead[]>();
  for (const head of heads) {
    const keyId = head.verifier.keyId;
    const list = byKey.get(keyId);
    if (list) list.push(head);
    else byKey.set(keyId, [head]);
  }
  const warnings: HeadPair[] = [];
  let found: HeadPair | null = null;
  for (const [keyId, list] of byKey) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = [list[i], list[j]];
        if (a.count === b.count && a.head === b.head) continue; // same claim, possibly reissued — consistent
        if (found) continue; // the first certain conflict is the report
        if (a.count === b.count) {
          found = { keyId, conflict: [a, b], reason: `two signed heads at count ${a.count} commit different tips` };
        } else if (a.head === b.head) {
          found = { keyId, conflict: [a, b], reason: `tip ${a.head.slice(0, 16)}… is signed at counts ${a.count} and ${b.count}` };
        }
      }
    }
    // Issuer-timestamped monotonicity: counts should not regress in issue order.
    const byIssue = [...list].sort((x, y) => x.issuedAt.localeCompare(y.issuedAt));
    let maxCount = -1;
    let maxHead: TlogHead | null = null;
    for (const head of byIssue) {
      if (maxHead && head.count < maxCount) warnings.push({ keyId, conflict: [maxHead, head], reason: "head counts regress" });
      if (head.count > maxCount) {
        maxCount = head.count;
        maxHead = head;
      }
    }
  }
  const report: EquivocationReport = { ok: !found, checked: heads.length };
  if (found) {
    report.keyId = found.keyId;
    report.conflict = found.conflict;
    report.reason = found.reason;
  }
  if (warnings.length) report.warnings = warnings;
  return report;
}

export interface ForkReport {
  /** False on a proven fork or on input that cannot be compared. */
  ok: boolean;
  /** True only on a proven fork: two valid signed chains that diverge. */
  equivocation: boolean;
  keyId?: string;
  /**
   * When there is no fork: how the shared prefixes relate —
   * "identical" (same chain), "a-prefix-of-b", or "b-prefix-of-a" (one log
   * is a strict ancestor of the other — growth or a stale copy, both
   * consistent).
   */
  relation?: "identical" | "a-prefix-of-b" | "b-prefix-of-a";
  /** On a proven fork: the first index whose entryHash differs. */
  forkIndex?: number;
  counts?: [number, number];
  reason?: string;
}

/**
 * Compare two published logs for a cryptographic fork — the case
 * `findEquivocation` cannot decide from heads alone. Both logs must pass
 * `checkLog` (full chain recompute + signed head) and share one verifier
 * key; then the first index whose `entryHash` differs is a proven
 * equivocation: each chain commits to its own history under the same
 * issuer key. `ok` is false on a proven fork (matching
 * `EquivocationReport`'s polarity) and on incomparable input — the
 * `equivocation` flag distinguishes them.
 *
 * Honest limit: this detects a fork only between two logs a verifier
 * actually holds. An issuer can fork privately — serve different logs to
 * different parties — and nothing is detected until both views reach one
 * verifier. A compact proof (a divergent suffix under each head) is future
 * work; today the evidence is the two published logs themselves.
 */
export function compareLogs(a: unknown, b: unknown): ForkReport {
  const checkA = checkLog(a);
  if (!checkA.ok) return { ok: false, equivocation: false, reason: `left log failed check: ${checkA.reason}` };
  const checkB = checkLog(b);
  if (!checkB.ok) return { ok: false, equivocation: false, reason: `right log failed check: ${checkB.reason}` };
  const logA = a as TransparencyLog;
  const logB = b as TransparencyLog;
  const keyId = logA.head.verifier.keyId;
  if (logB.head.verifier.keyId !== keyId) {
    return { ok: false, equivocation: false, reason: "logs are signed by different verifier keys" };
  }
  const counts: [number, number] = [logA.entries.length, logB.entries.length];
  const shared = Math.min(counts[0], counts[1]);
  for (let i = 0; i < shared; i++) {
    if (logA.entries[i].entryHash !== logB.entries[i].entryHash) {
      return { ok: false, equivocation: true, keyId, forkIndex: i, counts, reason: `chains diverge at index ${i}` };
    }
  }
  const relation = counts[0] === counts[1] ? "identical" : counts[0] < counts[1] ? "a-prefix-of-b" : "b-prefix-of-a";
  return { ok: true, equivocation: false, keyId, relation, counts };
}

/** Default poll interval for `--providers` watching: one minute. */
export const POLL_DEFAULT_MS = 60_000;
/** Poll interval bound — one day. */
export const POLL_MAX_MS = 86_400_000;
/** Each provider fetch is bounded to this many bytes — same bound as POST /heads. */
const POLL_HEAD_MAX_BYTES = 16 * 1024;
/** Each provider fetch times out after this long. */
const POLL_FETCH_TIMEOUT_MS = 10_000;
/** A providers file may name at most this many provider URLs. */
const PROVIDERS_MAX = 256;
/** A providers file may be at most this large. */
const PROVIDERS_MAX_BYTES = 256 * 1024;
/** One provider URL may be at most this long. */
const PROVIDER_URL_MAX = 2048;

/** Per-provider outcome of one poll: what `GET /status` reports. */
export type PollResult = "ok" | "fetch-error" | "invalid-head";

export interface ProviderStatus {
  /** The configured provider base URL, normalized (operator-supplied, not a secret). */
  url: string;
  /** ISO timestamp of the last completed poll attempt. */
  lastPollAt?: string;
  lastResult?: PollResult;
  /** Verifier keyId of the last accepted head from this provider. */
  keyId?: string;
}

/**
 * Parse a providers file — either `[{url}]` or `{providers: [{url}]}` —
 * into deduplicated http(s) base URLs. Returns null on anything
 * malformed: a bad file must never crash the service, only skip a cycle.
 */
function parseProvidersFile(value: unknown): string[] | null {
  const list = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object" && Array.isArray((value as { providers?: unknown }).providers)
      ? (value as { providers: unknown[] }).providers
      : null;
  if (list === null || list.length > PROVIDERS_MAX) return null;
  const urls = new Set<string>();
  for (const entry of list) {
    const raw = (entry as { url?: unknown } | null)?.url;
    if (typeof raw !== "string" || !raw.length || raw.length > PROVIDER_URL_MAX) return null;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    urls.add(parsed.toString());
  }
  return [...urls];
}

export const CONSISTENCY_PROTOCOL = "clankdar-tlog-consistency-v1";

/**
 * Append-only growth evidence — the transparency-log analogue of a CT
 * consistency proof, carried by the linear hash chain instead of a Merkle
 * tree. A client that pinned a `count:oldCount` head verifies that a new,
 * larger log extends what it pinned without replaying the prefix.
 */
export interface ConsistencyProof {
  protocol: typeof CONSISTENCY_PROTOCOL;
  /** Entries the verifier already pinned — the chain boundary. */
  oldCount: number;
  /** `entryHash` of entry `oldCount - 1` — the pinned head's tip (genesis zeroes at 0). */
  oldTip: string;
  newCount: number;
  /** The tip the suffix recomputes to — equal to `head.head`. */
  newTip: string;
  /** Entries `oldCount..newCount`; `suffix[0].prev` is the linkage back to `oldTip`. */
  suffix: TlogHashedEntry[];
  /** The signed head committing to `newCount`/`newTip`. */
  head: TlogHead;
}

/**
 * Emit the entries a log added after entry `oldCount`, wrapped in a
 * `clankdar-tlog-consistency-v1` proof. The log must pass `checkLog`
 * first — only a verified chain is worth proving growth over. The proof
 * is compact in growth only: it carries `newCount - oldCount` entries,
 * linear in how much the log grew, not Merkle-logarithmic.
 */
export function proveConsistency(log: TransparencyLog, oldCount: number): ConsistencyProof {
  const check = checkLog(log);
  if (!check.ok) throw new Error(`transparency log failed check: ${check.reason}`);
  if (!Number.isSafeInteger(oldCount) || oldCount < 0 || oldCount > log.entries.length) {
    throw new Error(`oldCount must be an integer in 0..${log.entries.length}`);
  }
  const oldTip = oldCount === 0 ? GENESIS : log.entries[oldCount - 1].entryHash;
  return {
    protocol: CONSISTENCY_PROTOCOL,
    oldCount,
    oldTip,
    newCount: log.entries.length,
    newTip: log.head.head,
    suffix: log.entries.slice(oldCount),
    head: log.head,
  };
}

/** The verifier's trust anchor for `checkConsistency` — one of the two, never both. */
export interface ConsistencyTrust {
  /** A signed head witnessed earlier (e.g. a recorded `/tlog/head`); validated before use. */
  pinnedHead?: unknown;
  /** Or a bare `{count, tip}` the verifier remembers trusting. */
  pinnedTip?: { count: number; tip: string };
}

export interface ConsistencyCheck {
  ok: boolean;
  oldCount?: number;
  newCount?: number;
  newTip?: string;
  /** The issuer key that signed the new head. */
  keyId?: string;
  reason?: string;
}

/**
 * Verify that a log is a chain-extension of a previously pinned head.
 * The chain is a linear hash chain, so the proof IS the suffix: if the
 * first suffix entry's `prev` equals the tip the verifier already trusts
 * and the suffix recomputes to `newTip` under a validly signed head, the
 * new log extends the pinned one.
 *
 * The trust comes from `pinned`, never from the proof: `proof.oldCount`/
 * `proof.oldTip` must MATCH the pin, so a prover cannot move the
 * boundary. Only `oldCount:0` is self-trusting — the genesis tip is the
 * public 64-zero constant — so a nonzero proof with no pin fails closed.
 *
 * Honest scope: this proves extension, not ledger semantics — suffix
 * entries are hash-checked, but session/decision ordering rules are
 * `checkLog`'s job on the full log. And it is sound ONLY IF the pinned
 * head was authentic: it cannot show the new log is the issuer's ONLY
 * extension (a post-boundary fork verifies against the same pin), so
 * fork accountability still needs both views at one witness.
 */
export function checkConsistency(proof: unknown, pinned?: ConsistencyTrust): ConsistencyCheck {
  const fail = (reason: string): ConsistencyCheck => ({ ok: false, reason });
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return fail("not a consistency proof");
  const p = proof as ConsistencyProof;
  if (p.protocol !== CONSISTENCY_PROTOCOL) return fail("not a clankdar-tlog-consistency-v1 proof");
  if (!Number.isSafeInteger(p.oldCount) || p.oldCount < 0) return fail("oldCount is not a nonnegative integer");
  if (!Number.isSafeInteger(p.newCount) || p.newCount < 0) return fail("newCount is not a nonnegative integer");
  if (typeof p.oldTip !== "string" || !HEX64.test(p.oldTip)) return fail("oldTip is malformed");
  if (typeof p.newTip !== "string" || !HEX64.test(p.newTip)) return fail("newTip is malformed");
  if (p.oldCount > p.newCount) return fail("oldCount exceeds newCount");
  if (!Array.isArray(p.suffix)) return fail("suffix is not an array");
  if (p.suffix.length !== p.newCount - p.oldCount) return fail("suffix length does not match the count delta");

  // The boundary the suffix must extend comes from what the verifier
  // already trusts — a witnessed signed head or a remembered count+tip —
  // never from the proof's own claims.
  let trustedTip: string;
  let pinnedKeyId: string | undefined;
  if (pinned?.pinnedHead !== undefined && pinned.pinnedTip !== undefined) {
    return fail("supply either a pinned head or a pinned tip, not both");
  } else if (pinned?.pinnedHead !== undefined) {
    if (!isSignedHead(pinned.pinnedHead)) return fail("pinned head is not a valid signed head");
    if (pinned.pinnedHead.count !== p.oldCount) {
      return fail(`pinned head count ${pinned.pinnedHead.count} does not match proof oldCount ${p.oldCount}`);
    }
    trustedTip = pinned.pinnedHead.head;
    pinnedKeyId = pinned.pinnedHead.verifier.keyId;
  } else if (pinned?.pinnedTip !== undefined) {
    const pin = pinned.pinnedTip;
    if (!Number.isSafeInteger(pin.count) || pin.count < 0) return fail("pinned count is not a nonnegative integer");
    if (typeof pin.tip !== "string" || !HEX64.test(pin.tip)) return fail("pinned tip is malformed");
    if (pin.count !== p.oldCount) return fail(`pinned count ${pin.count} does not match proof oldCount ${p.oldCount}`);
    trustedTip = pin.tip;
  } else {
    if (p.oldCount !== 0) return fail("no pinned old head supplied — only a genesis boundary (oldCount 0) is self-authenticating");
    trustedTip = GENESIS;
  }
  if (p.oldTip !== trustedTip) return fail("proof oldTip does not match the pinned tip");

  // Replay the suffix: index, shape, chain linkage, recomputed hash. The
  // first entry's `prev` is the security-relevant boundary check.
  let tip = p.oldTip;
  for (let i = 0; i < p.suffix.length; i++) {
    const entry = p.suffix[i];
    const index = p.oldCount + i;
    if (!entry || typeof entry !== "object") return fail(`entry ${index} is malformed`);
    if (entry.index !== index) return fail(`entry ${index} has the wrong index`);
    if (entry.type !== "session" && entry.type !== "decision") return fail(`entry ${index} has an unknown type`);
    if (typeof entry.sessionId !== "string" || !entry.sessionId.length) return fail(`entry ${index} has no sessionId`);
    if (typeof entry.digest !== "string" || !HEX64.test(entry.digest)) return fail(`entry ${index} has a malformed digest`);
    if (typeof entry.prev !== "string" || !HEX64.test(entry.prev)) return fail(`entry ${index} has a malformed prev`);
    if (typeof entry.entryHash !== "string" || !HEX64.test(entry.entryHash)) return fail(`entry ${index} has a malformed entryHash`);
    if (entry.prev !== tip) return fail(i === 0 ? "suffix does not extend the pinned tip" : `entry ${index} breaks the chain`);
    if (entryHashOf(entry) !== entry.entryHash) return fail(`entry ${index} hash does not recompute`);
    tip = entry.entryHash;
  }
  if (tip !== p.newTip) return fail("suffix does not recompute to the new tip");

  // The signed head must commit to exactly what the suffix recomputed,
  // under the same issuer key the pin was made by.
  if (!isSignedHead(p.head)) return fail("head is not a valid signed head");
  if (p.head.count !== p.newCount) return fail("head count does not match newCount");
  if (p.head.head !== p.newTip) return fail("head does not commit to the new tip");
  if (pinnedKeyId !== undefined && p.head.verifier.keyId !== pinnedKeyId) {
    return fail("new head is signed by a different verifier key than the pinned head");
  }
  return { ok: true, oldCount: p.oldCount, newCount: p.newCount, newTip: p.newTip, keyId: p.head.verifier.keyId };
}

/**
 * A head-witness service — the "common witness" the accountability story
 * needs. Any vantage (a checker polling an issuer's `/tlog/head`, another
 * witness, a log consumer) submits a signed head; the service validates
 * the signature standalone — the head carries its own publicKey — appends
 * it to the local registry, and answers whether that issuer key now has a
 * proven equivocation on record.
 *
 *   POST /heads                    body: one self-describing TlogHead
 *   GET  /heads?keyId=K&after=N    bounded pages across one or every provider
 *   GET  /equivocation/:keyId      findings for one provider key
 *   GET  /status                   per-provider poll state (when --providers is set)
 *   GET  /healthz
 *
 * With `opts.providers` naming a JSON file of `{url}` entries, the
 * service additionally polls each provider's `GET /tlog/head` every
 * `pollMs` (default one minute) and feeds valid signed heads through the
 * same normalization and append path as POST /heads. The file is re-read
 * every cycle so providers can be added or removed without a restart; an
 * unreadable or malformed file logs a bounded stderr warning and skips
 * the cycle — the service stays up. A fetched head identical in
 * count+tip to the latest stored head for its keyId is not re-appended,
 * so a provider that re-signs the same claim every poll cannot spam the
 * registry.
 *
 * Honest scope: unauthenticated — a submission self-validates by
 * signature and is indexed by its embedded keyId, so no central provider
 * registry is required. A provider URL is configuration, not trust: only
 * the head's own embedded verifier signature decides what is recorded,
 * and equivocation findings stay scoped to one keyId. Unsigned unknown
 * members are stripped before storage. There is no rate limit, no
 * provider discovery, and no gossip: heads arrive only via POST or a
 * configured provider poll, so a private fork stays invisible until both
 * views reach a witness like this one. The registry is the same
 * append-only JSONL `tlog witness` writes and `tlog equivocate` reads.
 */
export function serveWitness(opts: {
  heads: string;
  host?: string;
  port?: number;
  /** Path to a JSON providers file (`[{url}]` or `{providers: [{url}]}`), re-read each poll cycle. */
  providers?: string;
  /** Poll interval in ms — integer in 1..86400000, default 60000. Meaningful only with `providers`. */
  pollMs?: number;
}): { url: string; close: () => void } {
  if (opts.pollMs !== undefined && (!Number.isInteger(opts.pollMs) || opts.pollMs < 1 || opts.pollMs > POLL_MAX_MS)) {
    throw new Error(`pollMs must be an integer in 1..${POLL_MAX_MS}`);
  }
  const pollMs = opts.pollMs ?? POLL_DEFAULT_MS;
  const states = new Map<string, ProviderStatus>();
  let providersFileInvalid = false;
  const loadProviders = (): string[] | null => {
    try {
      if (statSync(opts.providers!).size > PROVIDERS_MAX_BYTES) return null;
      return parseProvidersFile(JSON.parse(readFileSync(opts.providers!, "utf8")));
    } catch {
      return null;
    }
  };
  /**
   * Fetch one provider's `/tlog/head` under a 10s timeout and a 16 KiB
   * bound, then validate it exactly like a POSTed head. The returned
   * status records the outcome; a valid head is returned for the
   * sequential append phase so parallel fetches cannot race the registry.
   */
  const pollProvider = async (url: string): Promise<{ status: ProviderStatus; head: TlogHead | null }> => {
    const status: ProviderStatus = { url, lastPollAt: new Date().toISOString() };
    let body: unknown;
    try {
      const res = await fetch(new URL("/tlog/head", url), { signal: AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS) });
      if (!res.ok) {
        status.lastResult = "fetch-error";
        return { status, head: null };
      }
      const text = await boundedText(res, POLL_HEAD_MAX_BYTES);
      if (text === null) {
        status.lastResult = "fetch-error";
        return { status, head: null };
      }
      try {
        body = JSON.parse(text);
      } catch {
        status.lastResult = "invalid-head";
        return { status, head: null };
      }
    } catch {
      status.lastResult = "fetch-error";
      return { status, head: null };
    }
    if (!isSignedHead(body)) {
      status.lastResult = "invalid-head";
      return { status, head: null };
    }
    status.lastResult = "ok";
    status.keyId = body.verifier.keyId;
    return { status, head: body };
  };
  let polling = false;
  const pollCycle = async (): Promise<void> => {
    if (polling || opts.providers === undefined) return;
    polling = true;
    try {
      const urls = loadProviders();
      if (urls === null) {
        providersFileInvalid = true;
        console.error(`tlog witness: providers file ${opts.providers} is unreadable or invalid; skipping poll cycle`);
        return;
      }
      providersFileInvalid = false;
      for (const known of [...states.keys()]) if (!urls.includes(known)) states.delete(known);
      const results = await Promise.all(urls.map(pollProvider));
      // Latest stored claim per keyId: a re-signed identical claim is skipped.
      let heads: TlogHead[] | null = null;
      try {
        heads = readHeads(opts.heads);
      } catch {
        heads = null;
      }
      if (heads === null) {
        console.error("tlog witness: heads registry unavailable; polled heads cannot be recorded");
      }
      const latestClaim = new Map<string, { count: number; head: string }>();
      for (const head of heads ?? []) latestClaim.set(head.verifier.keyId, { count: head.count, head: head.head });
      for (const { status, head } of results) {
        states.set(status.url, status);
        if (status.lastResult !== "ok") {
          console.error(`tlog witness: poll ${status.url} failed: ${status.lastResult}`);
          continue;
        }
        if (head === null || heads === null) continue;
        const latest = latestClaim.get(head.verifier.keyId);
        if (latest && latest.count === head.count && latest.head === head.head) continue;
        try {
          appendHead(opts.heads, head);
          latestClaim.set(head.verifier.keyId, { count: head.count, head: head.head });
        } catch {
          console.error("tlog witness: heads registry unavailable; polled head not recorded");
        }
      }
    } finally {
      polling = false;
    }
  };
  const timer = opts.providers === undefined ? null : setInterval(() => void pollCycle(), pollMs);
  if (timer) void pollCycle(); // first poll immediately, then on the interval
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const err = (status: number, error: string) => json({ error }, status);
  const registry = (): TlogHead[] | { error: string } => {
    try {
      return readHeads(opts.heads);
    } catch (error) {
      return { error: message(error) };
    }
  };
  const server = Bun.serve({
    hostname: opts.host ?? "127.0.0.1",
    port: opts.port ?? 8790,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") return json({ ok: true });
      if (req.method === "GET" && url.pathname === "/status") {
        const out: Record<string, unknown> = { ok: true, providers: [...states.values()] };
        if (opts.providers !== undefined) {
          out.pollMs = pollMs;
          if (providersFileInvalid) out.providersFile = "invalid";
        }
        return json(out);
      }
      const equivocationMatch = /^\/equivocation\/([0-9a-f]{16})$/.exec(url.pathname);
      if (req.method === "GET" && equivocationMatch) {
        const heads = registry();
        return Array.isArray(heads)
          ? json(findEquivocation(heads.filter((head) => head.verifier.keyId === equivocationMatch[1])))
          : err(500, "witness registry unavailable");
      }
      if (url.pathname === "/heads") {
        if (req.method === "GET") {
          const keyId = url.searchParams.get("keyId");
          if (keyId !== null && !/^[0-9a-f]{16}$/.test(keyId)) return err(400, "keyId must be 16 lowercase hex characters");
          const afterRaw = url.searchParams.get("after") ?? "0";
          const limitRaw = url.searchParams.get("limit") ?? "100";
          if (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(Number(afterRaw))) return err(400, "after must be a nonnegative safe integer");
          if (!/^\d+$/.test(limitRaw) || !Number.isSafeInteger(Number(limitRaw))) return err(400, "limit must be in 1..1000");
          const after = Number(afterRaw);
          const limit = Number(limitRaw);
          if (limit < 1 || limit > 1000) return err(400, "limit must be in 1..1000");
          const heads = registry();
          if (!Array.isArray(heads)) return err(500, "witness registry unavailable");
          const filtered = keyId === null ? heads : heads.filter((head) => head.verifier.keyId === keyId);
          const page = filtered.slice(after, after + limit).map(normalizedHead);
          const next = after + page.length < filtered.length ? after + page.length : null;
          return json({ heads: page, next });
        }
        if (req.method === "POST") {
          const text = await boundedText(req, 16 * 1024);
          if (text === null) return err(413, "request body exceeds 16 KiB");
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            return err(400, "request body must be a JSON head object");
          }
          if (!isSignedHead(body)) return err(400, "not a signed tlog head");
          let appended: { recorded: boolean; witnessed: number };
          try {
            appended = appendHead(opts.heads, body);
          } catch {
            return err(500, "witness registry unavailable");
          }
          const heads = registry();
          if (!Array.isArray(heads)) return err(500, "witness registry unavailable");
          const { recorded, witnessed } = appended;
          const providerHeads = heads.filter((head) => head.verifier.keyId === body.verifier.keyId);
          const report = findEquivocation(providerHeads);
          const out: Record<string, unknown> = {
            ok: true,
            recorded,
            keyId: body.verifier.keyId,
            witnessed,
            providerHeads: providerHeads.length,
            equivocation: !report.ok,
          };
          if (report.conflict) out.conflict = report.conflict;
          if (report.reason) out.reason = report.reason;
          if (report.warnings?.length) out.warnings = report.warnings;
          return json(out);
        }
      }
      return err(404, "not found");
    },
  });
  const host = opts.host ?? "127.0.0.1";
  return {
    url: `http://${host}:${server.port}`,
    close: () => {
      if (timer !== null) clearInterval(timer);
      server.stop(true);
    },
  };
}

function loadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${message(error)}`);
  }
}

const USAGE = `usage: tlog <command>
  build --dir GATE_STATE_DIR --key VERIFIER.json [--out tlog.json]
  check TLOG.json
  prove TLOG.json --session gs_xxx | --from-count N
  check-proof PROOF.json [--old-head HEAD.json | --old-tip HEX --old-count N]
  admit TLOG.json ADMISSION.json [--pool POOL.json]
  witness --heads HEADS.jsonl TLOG.json
  equivocate --heads HEADS.jsonl
  compare TLOG_A.json TLOG_B.json
  witness-serve --heads HEADS.jsonl [--host H] [--port N] [--providers PROVIDERS.json] [--poll-ms N]`;

export function main(args = process.argv.slice(2)): void {
  const [command, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      dir: { type: "string" }, key: { type: "string" }, out: { type: "string" }, pool: { type: "string" },
      session: { type: "string" }, heads: { type: "string" }, help: { type: "boolean", short: "h" },
      host: { type: "string" }, port: { type: "string" },
      providers: { type: "string" }, "poll-ms": { type: "string" },
      "from-count": { type: "string" },
      "old-head": { type: "string" }, "old-tip": { type: "string" }, "old-count": { type: "string" },
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

  if (command === "build") {
    need(values.dir, values.key);
    const log = buildLog({ dir: values.dir!, verifierJwk: loadJson(values.key!) as VerifierJwk });
    if (values.out) {
      writeFileSync(values.out, JSON.stringify(log, null, 2) + "\n", { flag: "wx" });
      console.error(`tlog: ${log.entries.length} entries, head ${log.head.head.slice(0, 16)}… → ${values.out}`);
    } else {
      console.log(JSON.stringify(log, null, 2));
    }
    return;
  }
  if (command === "check") {
    need(positionals[0]);
    const result = checkLog(loadJson(positionals[0]!));
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (command === "prove") {
    need(positionals[0]);
    if (values.session !== undefined && values["from-count"] !== undefined) {
      throw new Error(`prove takes either --session or --from-count, not both.\n${USAGE}`);
    }
    if (values["from-count"] !== undefined) {
      const raw = values["from-count"];
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw new Error("--from-count must be a nonnegative integer");
      }
      const proof = proveConsistency(loadJson(positionals[0]!) as TransparencyLog, Number(raw));
      console.log(JSON.stringify(proof, null, 2));
      return;
    }
    need(values.session);
    const proof = proveSession(loadJson(positionals[0]!) as TransparencyLog, values.session!);
    console.log(JSON.stringify(proof, null, 2));
    return;
  }
  if (command === "check-proof") {
    need(positionals[0]);
    let pinned: ConsistencyTrust | undefined;
    if (values["old-head"] !== undefined) {
      if (values["old-tip"] !== undefined || values["old-count"] !== undefined) {
        throw new Error(`check-proof takes either --old-head or --old-tip/--old-count, not both.\n${USAGE}`);
      }
      pinned = { pinnedHead: loadJson(values["old-head"]!) };
    } else if (values["old-tip"] !== undefined || values["old-count"] !== undefined) {
      need(values["old-tip"], values["old-count"]);
      const raw = values["old-count"]!;
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        throw new Error("--old-count must be a nonnegative integer");
      }
      pinned = { pinnedTip: { count: Number(raw), tip: values["old-tip"]! } };
    }
    const result = checkConsistency(loadJson(positionals[0]!), pinned);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (command === "admit") {
    need(positionals[0], positionals[1]);
    const result = checkLoggedAdmission(
      loadJson(positionals[0]!) as TransparencyLog,
      loadJson(positionals[1]!) as Admission,
      { pool: values.pool === undefined ? undefined : parsePool(loadJson(values.pool)) },
    );
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (command === "witness") {
    need(positionals[0], values.heads);
    const result = witnessHead(values.heads!, loadJson(positionals[0]!));
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (command === "equivocate") {
    need(values.heads);
    const report = findEquivocation(readHeads(values.heads!));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 2;
    return;
  }
  if (command === "compare") {
    need(positionals[0], positionals[1]);
    const report = compareLogs(loadJson(positionals[0]!), loadJson(positionals[1]!));
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 2;
    return;
  }
  if (command === "witness-serve") {
    need(values.heads);
    const port = values.port === undefined ? undefined : Number(values.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new Error("--port must be 1..65535");
    }
    const pollMs = values["poll-ms"] === undefined ? undefined : Number(values["poll-ms"]);
    if (pollMs !== undefined && (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > POLL_MAX_MS)) {
      throw new Error(`--poll-ms must be an integer in 1..${POLL_MAX_MS}`);
    }
    const { url } = serveWitness({ heads: values.heads!, host: values.host, port, providers: values.providers, pollMs });
    const watching = values.providers === undefined ? "" : `, providers: ${values.providers} every ${pollMs ?? POLL_DEFAULT_MS}ms`;
    console.error(`tlog witness serving on ${url} (heads: ${values.heads}${watching})`);
    return;
  }
  throw new Error(`unknown command: ${command}.\n${USAGE}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(message(error));
    process.exitCode = 2;
  }
}
