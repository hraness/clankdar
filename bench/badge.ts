#!/usr/bin/env bun
/**
 * clankdar-badge-v1 — portable subject badges over signed admissions.
 *
 *   bun bench/badge.ts pack --subject-key KEY.json --admissions a.json,b.json [--proofs proofs.json] [--out badge.json]
 *   bun bench/badge.ts check badge.json
 *
 * A respondent accumulates subject-bound admissions (§7 proofs, from any
 * issuer) under one Ed25519 key and packs them into a self-signed dossier a
 * third party replays without contacting anyone. The subject signs, never an
 * issuer — a badge is a curated claim "these signed episodes are bound to my
 * key", and admissions from different verifier keys mix freely. Optional
 * tlog inclusion proofs tie an admission's session to a logged decision,
 * upgrading issuer-claimed admissions to logged ones.
 *
 * Scope: a badge proves the subject key accumulated these admissions. It does
 * not prove the key holder solved anything — delegation survives aggregation —
 * and it does not prove the admissions were earned: a colluding issuer can
 * self-mint, which is why tlog proofs are optional but recommended. A badge
 * is never identity, liveness, or authority.
 */
import { parseArgs } from "node:util";
import { verify as cryptoVerify, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  canonical, keyIdOf, publicJwk, publicKeyOf, signBody,
  type ReceiptBody, type VerifierJwk,
} from "./attest.ts";
import { checkAdmission, type Admission, type AdmissionBody } from "./gate.ts";
import { proveSession, type SessionProof, type TransparencyLog } from "./tlog.ts";

export const BADGE_PROTOCOL = "clankdar-badge-v1";
const MAX_ADMISSIONS = 64;

/** Optional tlog inclusion evidence covering one admission's sessionId. */
export interface BadgeProof {
  log: TransparencyLog;
  proof: SessionProof;
}

/** The signed body inside `Badge.payload`. */
export interface BadgeBody {
  kind: "badge";
  /** Base64url Ed25519 JWK `x` — the respondent key that signs this badge. */
  subjectKey: string;
  /** 1..=64 subject-bound admissions, from any issuer. */
  admissions: Admission[];
  /** Optional tlog inclusion proofs; each names a carried session. */
  proofs?: BadgeProof[];
  issuedAt: string;
}

export interface Badge {
  protocol: typeof BADGE_PROTOCOL;
  payload: string;
  signature: string;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Pack subject-bound admissions into a badge signed by the subject key. The
 * packed badge is replayed through the independent checker before it is
 * returned — the same rule as a gate issuer re-checking minted receipts —
 * so this function never emits a badge that fails `checkBadge`.
 */
export function packBadge(opts: {
  admissions: Admission[];
  proofs?: BadgeProof[];
  subjectJwk: VerifierJwk;
  now?: Date;
}): Badge {
  const body: BadgeBody = {
    kind: "badge", subjectKey: publicKeyOf(opts.subjectJwk),
    admissions: opts.admissions,
    ...(opts.proofs !== undefined ? { proofs: opts.proofs } : {}),
    issuedAt: (opts.now ?? new Date()).toISOString(),
  };
  const badge: Badge = { protocol: BADGE_PROTOCOL, payload: canonical(body), signature: signBody(body, opts.subjectJwk) };
  const replay = checkBadge(badge);
  if (!replay.ok) throw new Error(`packed badge does not verify: ${replay.reason}`);
  return badge;
}

export interface BadgeCheck {
  ok: boolean;
  /** The badge's subject key (base64url JWK `x`). */
  subject?: string;
  admissions?: number;
  /** Count of admissions whose signed verdict is `pass`. */
  passed?: number;
  /** Count of admissions covered by at least one verified tlog proof. */
  logged?: number;
  reason?: string;
}

/**
 * Independently replay a badge: every admission must pass `checkAdmission`,
 * every admission must be bound to the badge's subject key (every
 * proof-carrying receipt uses `subjectKey`, and an admission with no proof
 * is not bound at all), optional tlog proofs must replay for their own
 * admission's sessionId, and the badge signature must verify over the
 * payload bytes under `subjectKey`.
 */
export function checkBadge(badge: Badge): BadgeCheck {
  const fail = (reason: string): BadgeCheck => ({ ok: false, reason });
  if (badge?.protocol !== BADGE_PROTOCOL || typeof badge.payload !== "string" || typeof badge.signature !== "string") return fail("not a badge");
  let body: BadgeBody;
  try {
    body = JSON.parse(badge.payload);
  } catch {
    return fail("payload is not JSON");
  }
  if (body?.kind !== "badge" || typeof body.subjectKey !== "string") return fail("malformed badge payload");
  let subjectKey: KeyObject;
  try {
    subjectKey = publicJwk(body.subjectKey);
  } catch {
    return fail("subjectKey is not an Ed25519 public key");
  }
  const admissions = body.admissions;
  if (!Array.isArray(admissions) || admissions.length < 1 || admissions.length > MAX_ADMISSIONS) return fail("admissions must be 1..64 signed admissions");
  const sessions = new Set<string>();
  let passed = 0;
  for (const admission of admissions) {
    const check = checkAdmission(admission);
    if (!check.ok) return fail(`admission does not verify: ${check.reason}`);
    const admissionBody = JSON.parse(admission.payload) as AdmissionBody;
    if (sessions.has(admissionBody.sessionId)) return fail("two admissions share a session");
    sessions.add(admissionBody.sessionId);
    let bound = false;
    for (const receipt of admissionBody.receipts) {
      const proof = (JSON.parse(receipt.payload) as ReceiptBody).subjectProof;
      if (proof === undefined) continue;
      if (proof.publicKey !== body.subjectKey) return fail("admission is bound to a different subject");
      bound = true;
    }
    if (!bound) return fail("admission is not subject-bound");
    if (check.verdict) passed++;
  }
  if (body.proofs !== undefined && !Array.isArray(body.proofs)) return fail("proofs is not an array");
  const proofs = body.proofs ?? [];
  if (proofs.length > MAX_ADMISSIONS) return fail("proofs exceed the admission bound");
  const logged = new Set<string>();
  for (const entry of proofs) {
    if (!entry || typeof entry !== "object" || typeof entry.proof?.sessionId !== "string") return fail("malformed inclusion proof");
    if (!sessions.has(entry.proof.sessionId)) return fail("proof names a session the badge does not carry");
    let expected: SessionProof;
    try {
      expected = proveSession(entry.log, entry.proof.sessionId);
    } catch (error) {
      return fail(`inclusion proof does not verify: ${message(error)}`);
    }
    if (entry.proof.sessionIndex !== expected.sessionIndex || entry.proof.decisionIndex !== expected.decisionIndex || canonical(entry.proof.head) !== canonical(expected.head)) {
      return fail("inclusion proof does not match the log");
    }
    if (entry.proof.decisionIndex === null) return fail("proof has no logged decision");
    logged.add(entry.proof.sessionId);
  }
  if (typeof body.issuedAt !== "string" || !Number.isFinite(Date.parse(body.issuedAt))) return fail("issuedAt is malformed");
  let verified = false;
  try {
    verified = cryptoVerify(null, Buffer.from(badge.payload), subjectKey, Buffer.from(badge.signature, "base64url"));
  } catch {
    verified = false;
  }
  if (!verified) return fail("badge signature does not verify");
  return { ok: true, subject: body.subjectKey, admissions: admissions.length, passed, logged: logged.size };
}

function loadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${message(error)}`);
  }
}

const USAGE = `usage: badge <command>
  pack --subject-key KEY.json --admissions A.json,B.json [--proofs PROOFS.json] [--out badge.json]
  check BADGE.json`;

export function main(args = process.argv.slice(2)): void {
  const [command, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      "subject-key": { type: "string" }, admissions: { type: "string" }, proofs: { type: "string" },
      out: { type: "string" }, help: { type: "boolean", short: "h" },
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

  if (command === "pack") {
    need(values["subject-key"], values.admissions);
    const subjectJwk = loadJson(values["subject-key"]!) as VerifierJwk;
    const admissions = values.admissions!.split(",").map((path) => loadJson(path.trim()) as Admission);
    const proofs = values.proofs !== undefined ? (loadJson(values.proofs) as BadgeProof[]) : undefined;
    const badge = packBadge({ admissions, proofs, subjectJwk });
    if (values.out) {
      writeFileSync(values.out, JSON.stringify(badge, null, 2) + "\n", { flag: "wx" });
      console.error(`badge: ${admissions.length} admissions for subject ${keyIdOf(publicKeyOf(subjectJwk))} → ${values.out}`);
    } else {
      console.log(JSON.stringify(badge, null, 2));
    }
    return;
  }
  if (command === "check") {
    need(positionals[0]);
    const result = checkBadge(loadJson(positionals[0]!) as Badge);
    console.log(JSON.stringify(result.ok
      ? { ok: true, subject: result.subject, admissions: result.admissions, verdicts: { pass: result.passed }, logged: result.logged }
      : { ok: false, reason: result.reason }));
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
