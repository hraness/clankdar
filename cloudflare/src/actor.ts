import { DurableObject } from "cloudflare:workers";
import { actorAuthHeaders, actorEventHash, canonical, requestTranscript, timestampCurrent, verifyActorSignature } from "./protocol.ts";
import { issuerIdentity } from "./issuer.ts";
import type { Env } from "./types.ts";

const GENESIS = "0".repeat(64);
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });

type ActorRow = { address: string; public_key: string; created_at: string };
type EventRow = { seq: number; at: string; type: string; payload: string; previous_hash: string; event_hash: string; issuer_payload: string; issuer_signature: string };

export class ActorState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS actor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        address TEXT NOT NULL,
        public_key TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS request_nonces (
        nonce TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL UNIQUE,
        issuer_payload TEXT NOT NULL,
        issuer_signature TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS request_nonces_seen_at ON request_nonces(seen_at);
    `);
  }

  private actor(): ActorRow | null {
    return [...this.ctx.storage.sql.exec<ActorRow>("SELECT address, public_key, created_at FROM actor WHERE singleton = 1")][0] ?? null;
  }

  private async appendEvent(type: string, payload: unknown, at: string): Promise<EventRow> {
    const latest = [...this.ctx.storage.sql.exec<{ seq: number; event_hash: string }>("SELECT seq, event_hash FROM events ORDER BY seq DESC LIMIT 1")][0];
    const seq = (latest?.seq ?? 0) + 1;
    const previousHash = latest?.event_hash ?? GENESIS;
    const actor = this.actor();
    if (!actor) throw new Error("actor is not initialized");
    const eventBody = { protocol: "clankdar-actor-event-v1", seq, actor: actor.address, at, type, payload, previousHash };
    const eventHash = await actorEventHash(previousHash, eventBody);
    const issuer = await issuerIdentity(this.env.ISSUER_JWK, this.env.ENVIRONMENT);
    const issuerBody = { ...eventBody, eventHash, issuer: { keyId: issuer.keyId, publicKey: issuer.publicKey } };
    const issuerPayload = canonical(issuerBody);
    const issuerSignature = await issuer.sign(issuerPayload);
    this.ctx.storage.sql.exec(
      "INSERT INTO events (seq, at, type, payload, previous_hash, event_hash, issuer_payload, issuer_signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      seq, at, type, canonical(payload), previousHash, eventHash, issuerPayload, issuerSignature,
    );
    return { seq, at, type, payload: canonical(payload), previous_hash: previousHash, event_hash: eventHash, issuer_payload: issuerPayload, issuer_signature: issuerSignature };
  }

  private async initialize(req: Request): Promise<Response> {
    if (req.headers.get("x-clankdar-internal") !== "initialize") return json({ ok: false, reason: "not found" }, 404);
    const value = await req.json() as { address?: unknown; publicKey?: unknown; createdAt?: unknown };
    if (typeof value.address !== "string" || typeof value.publicKey !== "string" || typeof value.createdAt !== "string") return json({ ok: false, reason: "invalid" }, 400);
    const existing = this.actor();
    if (existing) return existing.address === value.address && existing.public_key === value.publicKey ? json({ ok: true, created: false }) : json({ ok: false, reason: "conflict" }, 409);
    this.ctx.storage.sql.exec("INSERT INTO actor (singleton, address, public_key, created_at) VALUES (1, ?, ?, ?)", value.address, value.publicKey, value.createdAt);
    await this.appendEvent("registered", { publicKey: value.publicKey }, value.createdAt);
    return json({ ok: true, created: true }, 201);
  }

  private async authenticate(req: Request, body: Uint8Array): Promise<ActorRow | null> {
    const actor = this.actor();
    const auth = actorAuthHeaders(req.headers);
    if (!actor || !auth || !timestampCurrent(auth.timestamp)) return null;
    const transcript = await requestTranscript(actor.address, actor.public_key, auth.timestamp, auth.nonce, req.method, new URL(req.url).pathname, body);
    if (!await verifyActorSignature(actor.public_key, transcript, auth.signature)) return null;
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM request_nonces WHERE seen_at < ?", now - 600_000);
    try {
      this.ctx.storage.sql.exec("INSERT INTO request_nonces (nonce, seen_at) VALUES (?, ?)", auth.nonce, now);
    } catch {
      return null;
    }
    return actor;
  }

  private profile(): Response {
    const actor = this.actor();
    if (!actor) return json({ ok: false, reason: "not found" }, 404);
    const totals = [...this.ctx.storage.sql.exec<{ events: number; heartbeats: number }>("SELECT count(*) AS events, sum(CASE WHEN type = 'heartbeat' THEN 1 ELSE 0 END) AS heartbeats FROM events")][0];
    const head = [...this.ctx.storage.sql.exec<{ seq: number; event_hash: string; issuer_payload: string; issuer_signature: string }>("SELECT seq, event_hash, issuer_payload, issuer_signature FROM events ORDER BY seq DESC LIMIT 1")][0];
    return json({
      protocol: "clankdar-actor-v1", address: actor.address, publicKey: actor.public_key, createdAt: actor.created_at,
      evidence: { events: totals?.events ?? 0, heartbeats: totals?.heartbeats ?? 0 },
      head: head ? { seq: head.seq, eventHash: head.event_hash, payload: head.issuer_payload, signature: head.issuer_signature } : null,
      claims: { keyContinuity: true, autonomous: null, capability: null, unique: false },
    }, 200);
  }

  private events(url: URL): Response {
    if (!this.actor()) return json({ ok: false, reason: "not found" }, 404);
    const afterRaw = url.searchParams.get("after") ?? "0";
    const limitRaw = url.searchParams.get("limit") ?? "50";
    if (!/^\d+$/.test(afterRaw) || !/^\d+$/.test(limitRaw)) return json({ ok: false, reason: "invalid page" }, 400);
    const after = Number(afterRaw), limit = Math.min(Number(limitRaw), 100);
    if (!Number.isSafeInteger(after) || !Number.isSafeInteger(limit) || after < 0 || limit < 1) return json({ ok: false, reason: "invalid page" }, 400);
    const rows = [...this.ctx.storage.sql.exec<EventRow>("SELECT seq, at, type, payload, previous_hash, event_hash, issuer_payload, issuer_signature FROM events WHERE seq > ? ORDER BY seq LIMIT ?", after, limit)];
    const events = rows.map((row) => ({ seq: row.seq, at: row.at, type: row.type, payload: JSON.parse(row.payload), previousHash: row.previous_hash, eventHash: row.event_hash, envelope: { payload: row.issuer_payload, signature: row.issuer_signature } }));
    return json({ ok: true, events, next: events.length === limit ? events.at(-1)!.seq : null });
  }

  private async heartbeat(req: Request): Promise<Response> {
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.byteLength > 4096) return json({ ok: false, reason: "body too large" }, 413);
    const actor = await this.authenticate(req, body);
    if (!actor) return json({ ok: false, reason: "unauthorized" }, 401);
    let value: unknown;
    try { value = body.byteLength ? JSON.parse(new TextDecoder().decode(body)) : {}; } catch { return json({ ok: false, reason: "invalid body" }, 400); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return json({ ok: false, reason: "invalid body" }, 400);
    const note = (value as { note?: unknown }).note;
    if (note !== undefined && (typeof note !== "string" || note.length > 256)) return json({ ok: false, reason: "invalid body" }, 400);
    const at = new Date().toISOString();
    const minimum = Number(this.env.HEARTBEAT_MIN_SECONDS);
    if (!Number.isInteger(minimum) || minimum < 0 || minimum > 86_400) return json({ ok: false, reason: "service unavailable" }, 503);
    const latest = [...this.ctx.storage.sql.exec<{ at: string }>("SELECT at FROM events WHERE type = 'heartbeat' ORDER BY seq DESC LIMIT 1")][0];
    if (latest && Date.parse(at) - Date.parse(latest.at) < minimum * 1000) return json({ ok: false, reason: "rate limited" }, 429);
    const event = await this.appendEvent("heartbeat", note === undefined ? {} : { note }, at);
    this.ctx.waitUntil(this.env.REGISTRY.prepare("UPDATE actors SET last_seen_at = ?, event_count = event_count + 1 WHERE address = ?").bind(at, actor.address).run().catch(() => undefined));
    return json({ ok: true, address: actor.address, seq: event.seq, eventHash: event.event_hash }, 201);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/internal/initialize") return this.initialize(req);
    if (req.method === "GET" && url.pathname.endsWith("/events")) return this.events(url);
    if (req.method === "GET") return this.profile();
    if (req.method === "POST" && url.pathname.endsWith("/heartbeat")) return this.heartbeat(req);
    return json({ ok: false, reason: "not found" }, 404);
  }
}
