#!/usr/bin/env bun
/**
 * clankdar-tlog-v1 — a signed transparency log over gate issuance.
 *
 *   bun bench/tlog.ts build --dir gate-state/ --key verifier.json [--out tlog.json]
 *   bun bench/tlog.ts check tlog.json
 *   bun bench/tlog.ts prove tlog.json --session gs_xxx
 *   bun bench/tlog.ts admit tlog.json admission.json
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
 * it cannot detect a fork by itself: equivocation is visible only by
 * comparing heads the issuer published elsewhere (gossip or external
 * anchoring is future work).
 */
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonical, keyIdOf, publicKeyOf, signBody, verifyBodySignature,
  type Receipt, type VerifierJwk,
} from "./attest.ts";
import { checkAdmission, type Admission, type AdmissionBody, type GateSession } from "./gate.ts";

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
  reason?: string;
}

/**
 * Combined check: the admission must pass `checkAdmission` on its own AND
 * its sessionId must have both a session entry and a decision entry in a
 * log that itself verifies. This is the portable-badge test — a valid
 * admission with no logged session is issuer-claimed only.
 */
export function checkLoggedAdmission(log: TransparencyLog, admission: Admission): AdmittedCheck {
  const result = checkAdmission(admission);
  if (!result.ok) return { ok: false, reason: result.reason };
  const body = JSON.parse(admission.payload) as AdmissionBody;
  const check = checkLog(log);
  if (!check.ok) return { ok: false, verdict: result.verdict, passed: result.passed, reason: `transparency log failed check: ${check.reason}` };
  const hasSession = log.entries.some((entry) => entry.type === "session" && entry.sessionId === body.sessionId);
  if (!hasSession) return { ok: false, verdict: result.verdict, passed: result.passed, reason: `session ${body.sessionId} is not in the transparency log` };
  const hasDecision = log.entries.some((entry) => entry.type === "decision" && entry.sessionId === body.sessionId);
  if (!hasDecision) return { ok: false, verdict: result.verdict, passed: result.passed, reason: `session ${body.sessionId} has no logged decision` };
  return { ok: true, verdict: result.verdict, passed: result.passed };
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
  prove TLOG.json --session gs_xxx
  admit TLOG.json ADMISSION.json`;

export function main(args = process.argv.slice(2)): void {
  const [command, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      dir: { type: "string" }, key: { type: "string" }, out: { type: "string" },
      session: { type: "string" }, help: { type: "boolean", short: "h" },
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
    need(positionals[0], values.session);
    const proof = proveSession(loadJson(positionals[0]!) as TransparencyLog, values.session!);
    console.log(JSON.stringify(proof, null, 2));
    return;
  }
  if (command === "admit") {
    need(positionals[0], positionals[1]);
    const result = checkLoggedAdmission(
      loadJson(positionals[0]!) as TransparencyLog,
      loadJson(positionals[1]!) as Admission,
    );
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 2;
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
