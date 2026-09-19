/**
 * Issuer-side client keys for the hosted write path (bench/hosted.ts).
 *
 *   bun bench/hosted.ts keys issue --keys state/gate-keys.jsonl --name agent-7 --quota-mints 10 --quota-window 1h
 *   bun bench/hosted.ts keys list --keys state/gate-keys.jsonl
 *   bun bench/hosted.ts keys revoke --keys state/gate-keys.jsonl --key-id 0123abcdef…
 *   bun bench/hosted.ts serve … --auth-keys state/gate-keys.jsonl
 *
 * A client key is a bearer token (`clk_…`) the issuer mints out of band;
 * the store keeps only its SHA-256 — the raw token is printed once at
 * issue and never persisted. Serving with `--auth-keys` requires
 * `Authorization: Bearer <token>` on `POST /sessions` (the mint path):
 * missing, unknown, and revoked tokens all get one identical static 401,
 * and each key's optional quotas — live open sessions, and mints per
 * rolling window — apply on top of the gate's ledger-derived rate limits.
 *
 * The file is append-only JSONL like the gate ledger: `key` records mint,
 * `revoke` records revoke, `mint` records make quota history durable —
 * effective state is the fold, replayed on open. A torn final line (a
 * partial write from a crash) is dropped; mid-file corruption is fatal.
 * Quotas therefore hold across restarts.
 *
 * Scope: a client key is authorization to write to this issuer's ledger —
 * nothing more. It is not an identity, a personhood proof, or authority,
 * and it never enters `gate-state.jsonl` or the transparency log, so
 * published entries cannot reveal which key minted a session. The submit
 * path stays unauthenticated by design: a live session id is already the
 * unguessable capability `POST /sessions/:id/responses` consumes, and
 * per-key auth on mint is the control that bounds ledger spam.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { sha256 } from "./canon.ts";
import { SESSION_ID } from "./gate.ts";

/** Raw bearer token shape: `clk_` plus 24 random bytes as base64url (192 bits). */
export const CLIENT_TOKEN = /^clk_[A-Za-z0-9_-]{32}$/;
/** Key id shape: the first 16 hex of the token's SHA-256 — like verifier keyIds. */
export const KEY_ID = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_NAME = 128;
/** Maximum records a key file may hold — matching the heads registry's bound. */
export const KEYS_MAX_LINES = 1_000_000;

/** Per-key serving bounds; both are optional and compose the gate's own limits. */
export interface KeyQuota {
  /** Max live sessions (issued, undecided, unexpired) minted under this key. */
  openSessions?: number;
  /** Max sessions minted per rolling `seconds` window under this key. */
  mintsPerWindow?: { max: number; seconds: number };
}

interface KeyRecord {
  type: "key";
  keyId: string;
  /** SHA-256 hex of the raw bearer token — the token itself is never stored. */
  secretHash: string;
  name?: string;
  quota: KeyQuota;
  createdAt: string;
}

interface RevokeRecord {
  type: "revoke";
  keyId: string;
  revokedAt: string;
}

/** Durable quota bookkeeping: one record per session minted under a key. */
interface MintRecord {
  type: "mint";
  keyId: string;
  sessionId: string;
  at: string;
}

type KeyFileRecord = KeyRecord | RevokeRecord | MintRecord;

/** Public view of one client key — the secret hash never leaves the store. */
export interface ClientKeyView {
  keyId: string;
  name?: string;
  quota: KeyQuota;
  createdAt: string;
  revoked: boolean;
  revokedAt?: string;
  /** Sessions minted under this key (decided or not). */
  mints: number;
}

/** The ledger view the open-session quota needs — satisfied by `GateStore`. */
interface OpenSessionView {
  openSessions(nowMs: number): { sessionId: string }[];
}

/** Strictly bound a client-key quota — same rules as the gate's rate limits. */
export function parseQuota(value: unknown): KeyQuota {
  const fail = (message: string): never => {
    throw new Error(`invalid key quota: ${message}`);
  };
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) fail("expected an object");
  const q = value as Record<string, unknown>;
  const quota: KeyQuota = {};
  if (q.openSessions !== undefined) {
    if (!Number.isInteger(q.openSessions) || (q.openSessions as number) < 1) fail("openSessions must be a positive integer");
    quota.openSessions = q.openSessions as number;
  }
  if (q.mintsPerWindow !== undefined) {
    const w = q.mintsPerWindow;
    if (!w || typeof w !== "object" || Array.isArray(w)) fail("mintsPerWindow must be {max, seconds}");
    const { max, seconds } = w as { max?: unknown; seconds?: unknown };
    if (!Number.isInteger(max) || (max as number) < 1 || !Number.isInteger(seconds) || (seconds as number) < 1) {
      fail("mintsPerWindow needs positive integer max and seconds");
    }
    quota.mintsPerWindow = { max: max as number, seconds: seconds as number };
  }
  return quota;
}

const hashEq = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class KeyStore {
  private readonly fd: number;
  private readonly keys = new Map<string, { secretHash: string; name?: string; quota: KeyQuota; createdAt: string }>();
  private readonly revokedAt = new Map<string, string>();
  private readonly mints: { keyId: string; sessionId: string; at: number }[] = [];

  private constructor(fd: number) {
    this.fd = fd;
  }

  /** Open (or create) the key file and replay it. */
  static open(path: string): KeyStore {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const store = new KeyStore(openSync(path, "a", 0o600));
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n").filter((line) => line.length > 0);
    if (lines.length > KEYS_MAX_LINES) throw new Error(`client key store exceeds ${KEYS_MAX_LINES} records`);
    lines.forEach((line, index) => {
      let record: KeyFileRecord;
      try {
        record = JSON.parse(line) as KeyFileRecord;
      } catch {
        if (index === lines.length - 1) return; // torn tail from a crashed append
        throw new Error(`client key store is corrupt at record ${index + 1}`);
      }
      store.replay(record, index);
    });
    return store;
  }

  private replay(record: KeyFileRecord, index: number): void {
    const fail = (message: string): never => {
      throw new Error(`client key store has ${message} at record ${index + 1}`);
    };
    if (record?.type === "key") {
      if (typeof record.keyId !== "string" || !KEY_ID.test(record.keyId)) fail("a malformed keyId");
      if (typeof record.secretHash !== "string" || !HEX64.test(record.secretHash) || !record.secretHash.startsWith(record.keyId)) {
        fail("a malformed secretHash");
      }
      if (record.name !== undefined && (typeof record.name !== "string" || !record.name.length || record.name.length > MAX_NAME)) {
        fail("a malformed name");
      }
      if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) fail("a malformed createdAt");
      let quota: KeyQuota;
      try {
        quota = parseQuota(record.quota);
      } catch {
        return fail("a malformed quota");
      }
      if (this.keys.has(record.keyId)) fail("a duplicate key");
      this.keys.set(record.keyId, {
        secretHash: record.secretHash,
        ...(record.name !== undefined ? { name: record.name } : {}),
        quota,
        createdAt: record.createdAt,
      });
      return;
    }
    if (record?.type === "revoke") {
      if (typeof record.keyId !== "string" || !this.keys.has(record.keyId)) fail("a revocation for an unknown key");
      if (this.revokedAt.has(record.keyId)) fail("a duplicate revocation");
      if (typeof record.revokedAt !== "string" || !Number.isFinite(Date.parse(record.revokedAt))) fail("a malformed revokedAt");
      this.revokedAt.set(record.keyId, record.revokedAt);
      return;
    }
    if (record?.type === "mint") {
      if (typeof record.keyId !== "string" || !this.keys.has(record.keyId)) fail("a mint for an unknown key");
      if (typeof record.sessionId !== "string" || !SESSION_ID.test(record.sessionId)) fail("a malformed mint sessionId");
      const at = Date.parse(record.at);
      if (!Number.isFinite(at)) fail("a malformed mint timestamp");
      this.mints.push({ keyId: record.keyId, sessionId: record.sessionId, at });
      return;
    }
    fail("an unknown record type");
  }

  private append(record: KeyFileRecord): void {
    writeSync(this.fd, JSON.stringify(record) + "\n");
    fsyncSync(this.fd);
  }

  close(): void {
    closeSync(this.fd);
  }

  /**
   * Mint a client key: the raw `clk_…` token is returned once for the
   * operator to hand to the client; only its SHA-256 is persisted.
   */
  issue(opts?: { name?: string; quota?: KeyQuota; now?: Date }): { keyId: string; token: string } {
    const name = opts?.name;
    if (name !== undefined && (!name.length || name.length > MAX_NAME)) throw new Error(`name must be 1..${MAX_NAME} characters`);
    const quota = parseQuota(opts?.quota);
    let token = "";
    let secretHash = "";
    let keyId = "";
    do {
      token = `clk_${randomBytes(24).toString("base64url")}`;
      secretHash = sha256(token);
      keyId = secretHash.slice(0, 16);
    } while (this.keys.has(keyId));
    const record: KeyRecord = {
      type: "key", keyId, secretHash,
      ...(name !== undefined ? { name } : {}),
      quota, createdAt: (opts?.now ?? new Date()).toISOString(),
    };
    this.append(record);
    this.keys.set(keyId, { secretHash, ...(name !== undefined ? { name } : {}), quota, createdAt: record.createdAt });
    return { keyId, token };
  }

  /**
   * Resolve a bearer token to its keyId, or null when the token is
   * malformed, unknown, or revoked — callers must not distinguish the
   * three (one static 401 covers all of them).
   */
  authenticate(token: string): string | null {
    if (!CLIENT_TOKEN.test(token)) return null;
    const secretHash = sha256(token);
    const keyId = secretHash.slice(0, 16);
    const key = this.keys.get(keyId);
    if (!key || this.revokedAt.has(keyId) || !hashEq(key.secretHash, secretHash)) return null;
    return keyId;
  }

  /** Append a revocation; unknown or already-revoked keys refuse. */
  revoke(keyId: string, now?: Date): void {
    if (!this.keys.has(keyId)) throw new Error("unknown keyId");
    if (this.revokedAt.has(keyId)) throw new Error("key is already revoked");
    const revokedAt = (now ?? new Date()).toISOString();
    this.append({ type: "revoke", keyId, revokedAt });
    this.revokedAt.set(keyId, revokedAt);
  }

  /**
   * Record one accepted mint under a key — the durable history the
   * rolling-window quota counts. Lives here, not in the gate ledger, so
   * keyIds never reach the ledger or the derived transparency log.
   */
  recordMint(keyId: string, sessionId: string, now?: Date): void {
    if (!this.keys.has(keyId)) throw new Error("unknown keyId");
    if (!SESSION_ID.test(sessionId)) throw new Error("malformed sessionId");
    const at = (now ?? new Date()).toISOString();
    this.append({ type: "mint", keyId, sessionId, at });
    this.mints.push({ keyId, sessionId, at: Date.parse(at) });
  }

  /**
   * Whether a mint under `keyId` is inside the key's configured quotas at
   * `nowMs` — counted before issuance, same convention as the gate's rate
   * limits: `openSessions` caps live sessions the key minted (joined
   * against the ledger's live set), `mintsPerWindow` caps mints inside the
   * rolling window. A key with no quotas is always inside.
   */
  withinQuota(keyId: string, ledger: OpenSessionView, nowMs: number): boolean {
    const key = this.keys.get(keyId);
    if (!key || this.revokedAt.has(keyId)) return false;
    const { openSessions, mintsPerWindow } = key.quota;
    if (openSessions !== undefined) {
      const open = new Set(ledger.openSessions(nowMs).map((session) => session.sessionId));
      let held = 0;
      for (const mint of this.mints) {
        if (mint.keyId === keyId && open.has(mint.sessionId)) held++;
      }
      if (held >= openSessions) return false;
    }
    if (mintsPerWindow !== undefined) {
      const since = nowMs - mintsPerWindow.seconds * 1000;
      let minted = 0;
      for (const mint of this.mints) {
        if (mint.keyId === keyId && mint.at >= since) minted++;
      }
      if (minted >= mintsPerWindow.max) return false;
    }
    return true;
  }

  /** Every issued key, newest last; revocations folded in. Hashes stay inside. */
  list(): ClientKeyView[] {
    const out: ClientKeyView[] = [];
    for (const [keyId, key] of this.keys) {
      const revokedAt = this.revokedAt.get(keyId);
      out.push({
        keyId,
        ...(key.name !== undefined ? { name: key.name } : {}),
        quota: key.quota,
        createdAt: key.createdAt,
        revoked: revokedAt !== undefined,
        ...(revokedAt !== undefined ? { revokedAt } : {}),
        mints: this.mints.filter((mint) => mint.keyId === keyId).length,
      });
    }
    return out;
  }
}
