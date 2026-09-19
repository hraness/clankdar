import { DurableObject } from "cloudflare:workers";
import { actorAuthHeaders, actorEventHash, b64url, canonical, requestTranscript, sha256, timestampCurrent, verifyActorSignature } from "./protocol.ts";
import { issuerIdentity } from "./issuer.ts";
import { epochWindow, newScheduleSeed, parseCampaignConfig, scheduleCommit, type CampaignConfig } from "./campaign.ts";
import { HOSTED_POLICIES, issueHostedSession, submitHostedSession, type HostedSessionSecret } from "./challenges.ts";
import { openJson, sealJson } from "./seal.ts";
import type { Env } from "./types.ts";
import { readBody } from "./http.ts";

const GENESIS = "0".repeat(64);
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });

type ActorRow = { address: string; public_key: string; created_at: string; last_seen_at: string };
type EventRow = { seq: number; at: string; type: string; payload: string; previous_hash: string; event_hash: string; issuer_payload: string; issuer_signature: string };
type CampaignRow = { cursor: number; id: string; policy_id: string; epochs: number; cadence_seconds: number; window_seconds: number; starts_at: string; schedule_commit: string; sealed_seed: string; created_at: string; completed_at: string | null; schedule_reveal: string | null };
type EpochRow = { campaign_id: string; epoch: number; opens_at: string; closes_at: string; status: "missed" | "issued" | "decided"; session_id: string | null; evidence_hash: string | null; passed: number | null; verdict: number | null; latency_ms: number | null };
type SessionRow = { id: string; campaign_id: string; epoch: number; issued_at: string; expires_at: string; sealed_ticket: string | null; decided_at: string | null; evidence_hash: string | null };

type OutboxRow = { evidence_hash: string; evidence_text: string };
const MAX_CAMPAIGNS = 32;
const MAX_LIFETIME_EPOCHS = 1024;
const MAX_EVIDENCE_BYTES = 262_144;
const MISS_BATCH = 8;

export class ActorState extends DurableObject<Env> {
  // Async crypto and R2 calls yield outside storage input gates. Serialize this
  // small actor's requests explicitly; every durable transition also commits
  // its event in one SQLite transaction, so eviction cannot split the two.
  private requestTail: Promise<void> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS actor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        address TEXT NOT NULL,
        public_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        policy_id TEXT NOT NULL,
        epochs INTEGER NOT NULL,
        cadence_seconds INTEGER NOT NULL,
        window_seconds INTEGER NOT NULL,
        starts_at TEXT NOT NULL,
        schedule_commit TEXT NOT NULL,
        sealed_seed TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        schedule_reveal TEXT,
        cursor INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS campaign_epochs (
        campaign_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        opens_at TEXT NOT NULL,
        closes_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('missed', 'issued', 'decided')),
        session_id TEXT,
        evidence_hash TEXT,
        passed INTEGER,
        verdict INTEGER,
        latency_ms INTEGER,
        PRIMARY KEY (campaign_id, epoch)
      );
      CREATE INDEX IF NOT EXISTS campaign_epochs_status ON campaign_epochs(campaign_id, status, epoch);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        sealed_ticket TEXT,
        decided_at TEXT,
        evidence_hash TEXT,
        UNIQUE (campaign_id, epoch)
      );
      CREATE TABLE IF NOT EXISTS missed_ranges (
        campaign_id TEXT NOT NULL,
        first_epoch INTEGER NOT NULL,
        last_epoch INTEGER NOT NULL,
        PRIMARY KEY (campaign_id, first_epoch)
      );
      CREATE TABLE IF NOT EXISTS evidence_outbox (
        evidence_hash TEXT PRIMARY KEY,
        evidence_text TEXT NOT NULL
      );
    `);
    // Additive migrations preserve the existing staging actors/campaigns.
    const actorColumns = [...ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(actor)")];
    if (!actorColumns.some((column) => column.name === "last_seen_at")) {
      ctx.storage.transactionSync(() => {
        ctx.storage.sql.exec("ALTER TABLE actor ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT ''");
        ctx.storage.sql.exec("UPDATE actor SET last_seen_at = created_at");
      });
    }
    const campaignColumns = [...ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(campaigns)")];
    if (!campaignColumns.some((column) => column.name === "cursor")) {
      ctx.storage.transactionSync(() => {
        ctx.storage.sql.exec("ALTER TABLE campaigns ADD COLUMN cursor INTEGER NOT NULL DEFAULT 0");
        ctx.storage.sql.exec("UPDATE campaigns SET cursor = COALESCE((SELECT max(epoch) + 1 FROM campaign_epochs WHERE campaign_id = campaigns.id AND status IN ('missed', 'decided')), 0)");
      });
    }
  }

  private actor(): ActorRow | null {
    return [...this.ctx.storage.sql.exec<ActorRow>("SELECT address, public_key, created_at, last_seen_at FROM actor WHERE singleton = 1")][0] ?? null;
  }

  private async appendEvent(type: string, payload: unknown, at: string, mutate: () => void = () => {}, actorAddress?: string, actorSeen = true): Promise<EventRow> {
    const latest = [...this.ctx.storage.sql.exec<{ seq: number; event_hash: string }>("SELECT seq, event_hash FROM events ORDER BY seq DESC LIMIT 1")][0];
    const seq = (latest?.seq ?? 0) + 1;
    const previousHash = latest?.event_hash ?? GENESIS;
    const address = actorAddress ?? this.actor()?.address;
    if (!address) throw new Error("actor is not initialized");
    const eventBody = { protocol: "clankdar-actor-event-v1", seq, actor: address, at, type, payload, previousHash };
    const eventHash = await actorEventHash(previousHash, eventBody);
    const issuer = await issuerIdentity(this.env.ISSUER_JWK, this.env.ENVIRONMENT);
    const issuerPayload = canonical({ ...eventBody, eventHash, issuer: { keyId: issuer.keyId, publicKey: issuer.publicKey } });
    const issuerSignature = await issuer.sign(issuerPayload);
    this.ctx.storage.transactionSync(() => {
      mutate();
      this.ctx.storage.sql.exec(
        "INSERT INTO events (seq, at, type, payload, previous_hash, event_hash, issuer_payload, issuer_signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        seq, at, type, canonical(payload), previousHash, eventHash, issuerPayload, issuerSignature,
      );
      if (actorSeen) this.ctx.storage.sql.exec("UPDATE actor SET last_seen_at = ? WHERE singleton = 1", at);
    });
    this.project();
    return { seq, at, type, payload: canonical(payload), previous_hash: previousHash, event_hash: eventHash, issuer_payload: issuerPayload, issuer_signature: issuerSignature };
  }

  private async initialize(req: Request): Promise<Response> {
    if (req.headers.get("x-clankdar-internal") !== "initialize") return json({ ok: false, reason: "not found" }, 404);
    const value = await req.json() as { address?: unknown; publicKey?: unknown; createdAt?: unknown };
    if (typeof value.address !== "string" || typeof value.publicKey !== "string" || typeof value.createdAt !== "string") return json({ ok: false, reason: "invalid" }, 400);
    const existing = this.actor();
    if (existing) { this.project(); return existing.address === value.address && existing.public_key === value.publicKey ? json({ ok: true, created: false }) : json({ ok: false, reason: "conflict" }, 409); }
    const { address, publicKey, createdAt } = value;
    await this.appendEvent("registered", { publicKey }, createdAt, () => {
      this.ctx.storage.sql.exec("INSERT INTO actor (singleton, address, public_key, created_at, last_seen_at) VALUES (1, ?, ?, ?, ?)", address, publicKey, createdAt, createdAt);
    }, address);
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

  private async body(req: Request, cap = 131_072): Promise<{ bytes: Uint8Array; value: Record<string, unknown> } | null> {
    const bytes = await readBody(req, cap);
    if (!bytes) return null;
    try {
      const value = bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : {};
      return value && typeof value === "object" && !Array.isArray(value) ? { bytes, value } : null;
    } catch { return null; }
  }

  private campaignConfig(row: CampaignRow): CampaignConfig {
    return { policyId: row.policy_id, epochs: row.epochs, cadenceSeconds: row.cadence_seconds, windowSeconds: row.window_seconds, startsAt: row.starts_at };
  }

  private project(): void {
    const actor = this.actor();
    if (!actor) return;
    const head = [...this.ctx.storage.sql.exec<{ seq: number }>("SELECT seq FROM events ORDER BY seq DESC LIMIT 1")][0];
    // Absolute monotone snapshots tolerate failure/retry and out-of-order D1 IO.
    this.ctx.waitUntil(this.env.REGISTRY.prepare("UPDATE actors SET last_seen_at = max(last_seen_at, ?), event_count = max(event_count, ?) WHERE address = ?")
      .bind(actor.last_seen_at, head?.seq ?? 1, actor.address).run().catch(() => undefined));
  }

  private async finalizeCampaign(row: CampaignRow, actor: ActorRow, at: string): Promise<void> {
    if (row.completed_at !== null || row.cursor < row.epochs) return;
    const seed = await openJson<string>(row.sealed_seed, `campaign:${actor.address}:${row.id}`, this.env.SESSION_WRAP_KEY, this.env.ENVIRONMENT);
    await this.appendEvent("campaign-completed", { campaignId: row.id, scheduleSeed: seed }, at, () => {
      this.ctx.storage.sql.exec("UPDATE campaigns SET completed_at = ?, schedule_reveal = ?, sealed_seed = '' WHERE id = ? AND completed_at IS NULL", at, seed, row.id);
    }, undefined, false);
  }

  private async seed(row: CampaignRow): Promise<string> {
    return row.schedule_reveal ?? openJson<string>(row.sealed_seed, `campaign:${this.actor()!.address}:${row.id}`, this.env.SESSION_WRAP_KEY, this.env.ENVIRONMENT);
  }

  private async elapsedEpochs(row: CampaignRow, now: number): Promise<number> {
    if (row.completed_at) return row.epochs;
    // Every earlier cadence slot has ended. Only the current slot needs a
    // schedule hash, regardless of campaign age or the event catch-up cursor.
    const index = Math.max(0, Math.min(row.epochs, Math.floor((now - Date.parse(row.starts_at) - 1) / (row.cadence_seconds * 1000))));
    if (index >= row.epochs || now < Date.parse(row.starts_at)) return index;
    const window = await epochWindow(this.campaignConfig(row), await this.seed(row), index);
    const session = [...this.ctx.storage.sql.exec<{ expires_at: string }>("SELECT expires_at FROM sessions WHERE campaign_id = ? AND epoch = ? AND decided_at IS NULL", row.id, index)][0];
    return now > Date.parse(window.closesAt) || (session && now > Date.parse(session.expires_at)) ? index + 1 : index;
  }

  private async campaignPublic(row: CampaignRow, now = Date.now()) {
    const elapsed = await this.elapsedEpochs(row, now);
    const counts = [...this.ctx.storage.sql.exec<{ materialized: number; completed: number; missed: number; admitted: number; challenges_passed: number; decided_elapsed: number }>(`
      SELECT count(*) AS materialized,
        sum(CASE WHEN status = 'decided' THEN 1 ELSE 0 END) AS completed,
        sum(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) AS missed,
        sum(CASE WHEN status = 'decided' AND verdict = 1 THEN 1 ELSE 0 END) AS admitted,
        sum(CASE WHEN status = 'decided' THEN passed ELSE 0 END) AS challenges_passed,
        sum(CASE WHEN status = 'decided' AND epoch < ? THEN 1 ELSE 0 END) AS decided_elapsed
      FROM campaign_epochs WHERE campaign_id = ?
    `, elapsed, row.id)][0];
    const missed = Math.max(0, elapsed - (counts?.decided_elapsed ?? 0));
    const completed = counts?.completed ?? 0;
    const ranged = [...this.ctx.storage.sql.exec<{ count: number }>("SELECT coalesce(sum(last_epoch - first_epoch + 1), 0) AS count FROM missed_ranges WHERE campaign_id = ?", row.id)][0]!.count;
    const pendingEvidence = [...this.ctx.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM sessions s JOIN evidence_outbox o ON o.evidence_hash = s.evidence_hash WHERE s.campaign_id = ?", row.id)][0]!.count;
    return {
      protocol: "clankdar-campaign-v1", campaignId: row.id, policyId: row.policy_id,
      epochs: row.epochs, cadenceSeconds: row.cadence_seconds, windowSeconds: row.window_seconds,
      startsAt: row.starts_at, scheduleCommit: row.schedule_commit, createdAt: row.created_at,
      completedAt: row.completed_at, ...(row.schedule_reveal ? { scheduleSeed: row.schedule_reveal } : {}),
      evidence: { scheduled: row.epochs, elapsed, materialized: (counts?.materialized ?? 0) + ranged,
        completed, missed, pending: row.epochs - completed - missed, pendingEvidence,
        unmaterializedMisses: Math.max(0, missed - (counts?.missed ?? 0) - ranged),
        admitted: counts?.admitted ?? 0, challengesPassed: counts?.challenges_passed ?? 0 },
    };
  }

  private async materializeMisses(row: CampaignRow, actor: ActorRow, now: Date, maximum = MISS_BATCH): Promise<number> {
    if (row.completed_at) return 0;
    const elapsed = await this.elapsedEpochs(row, now.getTime());
    const seed = await this.seed(row);
    let count = 0;
    let epoch = row.cursor;
    while (epoch < elapsed && count < maximum) {
      const outcome = [...this.ctx.storage.sql.exec<EpochRow>("SELECT * FROM campaign_epochs WHERE campaign_id = ? AND epoch >= ? AND epoch < ? ORDER BY epoch LIMIT 1", row.id, epoch, elapsed)][0];
      if (!outcome || outcome.epoch > epoch) {
        // No challenge was issued in this contiguous range. One signed range
        // preserves every missed denominator without a hash/write per window.
        // Revealing the committed seed reconstructs each individual window.
        const last = (outcome?.epoch ?? elapsed) - 1;
        const first = epoch;
        await this.appendEvent("epochs-missed", { campaignId: row.id, firstEpoch: first, lastEpoch: last, count: last - first + 1 }, now.toISOString(), () => {
          this.ctx.storage.sql.exec("INSERT INTO missed_ranges (campaign_id, first_epoch, last_epoch) VALUES (?, ?, ?)", row.id, first, last);
          this.ctx.storage.sql.exec("UPDATE campaigns SET cursor = ? WHERE id = ?", last + 1, row.id);
        }, undefined, false);
        epoch = last + 1;
        count++;
        continue;
      }
      if (outcome.status === "missed" || outcome.status === "decided") {
        this.ctx.storage.sql.exec("UPDATE campaigns SET cursor = max(cursor, ?) WHERE id = ?", epoch + 1, row.id);
        epoch++;
        continue;
      }
      const window = await epochWindow(this.campaignConfig(row), seed, epoch);
      await this.appendEvent("epoch-missed", { campaignId: row.id, ...(outcome.session_id ? { sessionId: outcome.session_id } : {}), ...window }, now.toISOString(), () => {
        this.ctx.storage.sql.exec("UPDATE campaign_epochs SET status = 'missed' WHERE campaign_id = ? AND epoch = ?", row.id, epoch);
        if (outcome.session_id) this.ctx.storage.sql.exec("UPDATE sessions SET decided_at = ?, sealed_ticket = NULL WHERE id = ? AND decided_at IS NULL", now.toISOString(), outcome.session_id);
        this.ctx.storage.sql.exec("UPDATE campaigns SET cursor = ? WHERE id = ?", epoch + 1, row.id);
      }, undefined, false);
      epoch++;
      count++;
    }
    const refreshed = [...this.ctx.storage.sql.exec<CampaignRow>("SELECT * FROM campaigns WHERE id = ?", row.id)][0]!;
    await this.finalizeCampaign(refreshed, actor, now.toISOString());
    return count;
  }

  private async publishEvidence(hash: string): Promise<string | null> {
    const pending = [...this.ctx.storage.sql.exec<OutboxRow>("SELECT * FROM evidence_outbox WHERE evidence_hash = ?", hash)][0];
    if (!pending) return null;
    const stored = await this.env.EVIDENCE.put(`sha256/${hash}.json`, pending.evidence_text, {
      onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/json" },
    });
    if (!stored) {
      const existing = await this.env.EVIDENCE.get(`sha256/${hash}.json`);
      if (!existing || await sha256(await existing.text()) !== hash) throw new Error("evidence publication mismatch");
    }
    this.ctx.storage.sql.exec("DELETE FROM evidence_outbox WHERE evidence_hash = ?", hash);
    return pending.evidence_text;
  }

  private async flushOutbox(): Promise<void> {
    const pending = [...this.ctx.storage.sql.exec<OutboxRow>("SELECT * FROM evidence_outbox LIMIT 1")][0];
    if (pending) await this.publishEvidence(pending.evidence_hash).catch(() => undefined);
  }

  private async createCampaign(req: Request): Promise<Response> {
    const parsed = await this.body(req, 8192);
    if (!parsed) return json({ ok: false, reason: "invalid body" }, 400);
    const actor = await this.authenticate(req, parsed.bytes);
    if (!actor) return json({ ok: false, reason: "unauthorized" }, 401);
    let config: CampaignConfig;
    try { config = parseCampaignConfig(parsed.value); } catch { return json({ ok: false, reason: "invalid campaign" }, 400); }
    if (!HOSTED_POLICIES[config.policyId]) return json({ ok: false, reason: "unknown policy" }, 400);
    const lifetime = [...this.ctx.storage.sql.exec<{ campaigns: number; epochs: number }>("SELECT count(*) AS campaigns, coalesce(sum(epochs), 0) AS epochs FROM campaigns")][0]!;
    if (lifetime.campaigns >= MAX_CAMPAIGNS || lifetime.epochs + config.epochs > MAX_LIFETIME_EPOCHS) return json({ ok: false, reason: "staging campaign capacity reached" }, 429);
    const active = [...this.ctx.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM campaigns WHERE completed_at IS NULL")][0]?.count ?? 0;
    if (active >= 4) return json({ ok: false, reason: "campaign quota" }, 429);
    const campaignId = `cmp_${b64url(crypto.getRandomValues(new Uint8Array(12)))}`;
    const seed = newScheduleSeed();
    const commitment = await scheduleCommit(campaignId, seed);
    const createdAt = new Date().toISOString();
    const sealed = await sealJson(seed, `campaign:${actor.address}:${campaignId}`, this.env.SESSION_WRAP_KEY, this.env.ENVIRONMENT);
    await this.appendEvent("campaign-started", { campaignId, policyId: config.policyId, epochs: config.epochs, cadenceSeconds: config.cadenceSeconds, windowSeconds: config.windowSeconds, startsAt: config.startsAt, scheduleCommit: commitment }, createdAt, () => {
      this.ctx.storage.sql.exec(
        "INSERT INTO campaigns (id, policy_id, epochs, cadence_seconds, window_seconds, starts_at, schedule_commit, sealed_seed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        campaignId, config.policyId, config.epochs, config.cadenceSeconds, config.windowSeconds, config.startsAt, commitment, sealed, createdAt,
      );
    });
    return json({ ok: true, campaign: await this.campaignPublic([...this.ctx.storage.sql.exec<CampaignRow>("SELECT * FROM campaigns WHERE id = ?", campaignId)][0]!) }, 201);
  }

  private async campaign(id: string, url: URL): Promise<Response> {
    const after = Number(url.searchParams.get("after") ?? "-1");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    if (!Number.isSafeInteger(after) || after < -1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return json({ ok: false, reason: "invalid page" }, 400);
    let row = [...this.ctx.storage.sql.exec<CampaignRow>("SELECT * FROM campaigns WHERE id = ?", id)][0];
    if (!row) return json({ ok: false, reason: "not found" }, 404);
    const actor = this.actor();
    if (!actor) return json({ ok: false, reason: "not found" }, 404);
    await this.flushOutbox();
    await this.materializeMisses(row, actor, new Date());
    row = [...this.ctx.storage.sql.exec<CampaignRow>("SELECT * FROM campaigns WHERE id = ?", id)][0]!;
    const summary = await this.campaignPublic(row);
    const stored = [...this.ctx.storage.sql.exec<EpochRow>("SELECT * FROM campaign_epochs WHERE campaign_id = ? AND epoch > ? ORDER BY epoch LIMIT ?", id, after, limit)];
    const visible = Math.max(summary.evidence.elapsed, row.cursor, ...stored.map((epoch) => epoch.epoch + 1));
    const seed = await this.seed(row);
    const epochs = [];
    for (let epoch = after + 1; epoch < Math.min(visible, after + limit + 1); epoch++) {
      const outcome = stored.find((item) => item.epoch === epoch);
      const window = await epochWindow(this.campaignConfig(row), seed, epoch);
      epochs.push({ ...window, status: outcome?.status === "decided" ? "decided" : epoch < summary.evidence.elapsed ? "missed" : outcome?.status ?? "scheduled",
        sessionId: outcome?.session_id ?? null, evidenceHash: outcome?.evidence_hash ?? null,
        passed: outcome?.passed ?? null, verdict: outcome?.verdict === null || outcome?.verdict === undefined ? null : outcome.verdict === 1, latencyMs: outcome?.latency_ms ?? null });
    }
    return json({ ok: true, campaign: { ...summary, epochsPage: { epochs, next: after + epochs.length + 1 < visible ? after + epochs.length : null } } });
  }

  private async nextEpoch(req: Request, campaignId: string): Promise<Response> {
    const actor = await this.authenticate(req, new Uint8Array());
    if (!actor) return json({ ok: false, reason: "unauthorized" }, 401);
    let campaign = [...this.ctx.storage.sql.exec<CampaignRow>("SELECT * FROM campaigns WHERE id = ?", campaignId)][0];
    if (!campaign) return json({ ok: false, reason: "not found" }, 404);
    await this.flushOutbox();
    const caughtUp = await this.materializeMisses(campaign, actor, new Date());
    campaign = [...this.ctx.storage.sql.exec<CampaignRow>("SELECT * FROM campaigns WHERE id = ?", campaignId)][0]!;
    if (campaign.completed_at) return json({ ok: true, campaign: await this.campaignPublic(campaign), state: "completed" });
    if (campaign.cursor < await this.elapsedEpochs(campaign, Date.now())) return json({ ok: true, state: "catching-up", materialized: caughtUp });
    const epoch = campaign.cursor;
    const now = new Date();
    const window = await epochWindow(this.campaignConfig(campaign), await this.seed(campaign), epoch);
    if (now.getTime() < Date.parse(window.opensAt)) return json({ ok: true, state: "waiting", next: window });
    const session = [...this.ctx.storage.sql.exec<SessionRow>("SELECT * FROM sessions WHERE campaign_id = ? AND epoch = ?", campaignId, epoch)][0];
    if (session) {
      if (!session.sealed_ticket) return json({ ok: false, reason: "session unavailable" }, 503);
      const secret = await openJson<HostedSessionSecret>(session.sealed_ticket, `session:${actor.address}:${session.id}`, this.env.SESSION_WRAP_KEY, this.env.ENVIRONMENT);
      return json({ ok: true, state: "issued", campaignId, epoch, sessionId: session.id, expiresAt: session.expires_at, challenges: secret.tickets.map((ticket) => ticket.challenge) });
    }
    const issuer = await issuerIdentity(this.env.ISSUER_JWK, this.env.ENVIRONMENT);
    const policy = HOSTED_POLICIES[campaign.policy_id];
    const expiresAt = new Date(Math.min(Date.parse(window.closesAt), now.getTime() + policy.ttlSeconds * 1000));
    const issued = await issueHostedSession({ policy, actor: actor.address, campaignId, epoch, issuer, now, expiresAt });
    const sealedTicket = await sealJson(issued.secret, `session:${actor.address}:${issued.secret.sessionId}`, this.env.SESSION_WRAP_KEY, this.env.ENVIRONMENT);
    const challengesHash = await sha256(canonical(issued.challenges));
    await this.appendEvent("epoch-issued", { campaignId, epoch, sessionId: issued.secret.sessionId, expiresAt: issued.secret.expiresAt, challengesHash }, now.toISOString(), () => {
      this.ctx.storage.sql.exec("INSERT INTO sessions (id, campaign_id, epoch, issued_at, expires_at, sealed_ticket) VALUES (?, ?, ?, ?, ?, ?)", issued.secret.sessionId, campaignId, epoch, issued.secret.issuedAt, issued.secret.expiresAt, sealedTicket);
      this.ctx.storage.sql.exec("INSERT INTO campaign_epochs (campaign_id, epoch, opens_at, closes_at, status, session_id) VALUES (?, ?, ?, ?, 'issued', ?)", campaignId, epoch, window.opensAt, window.closesAt, issued.secret.sessionId);
    });
    return json({ ok: true, state: "issued", campaignId, epoch, sessionId: issued.secret.sessionId, expiresAt: issued.secret.expiresAt, challenges: issued.challenges }, 201);
  }

  private async decidedResponse(session: SessionRow, status = 200): Promise<Response> {
    if (!session.evidence_hash) return json({ ok: false, reason: "session consumed" }, 409);
    let evidenceText: string | null;
    try {
      evidenceText = await this.publishEvidence(session.evidence_hash);
      if (!evidenceText) evidenceText = await (await this.env.EVIDENCE.get(`sha256/${session.evidence_hash}.json`))?.text() ?? null;
    } catch {
      return json({ ok: false, reason: "evidence publication pending", retryable: true, sessionId: session.id, evidenceHash: session.evidence_hash }, 503);
    }
    if (!evidenceText || await sha256(evidenceText) !== session.evidence_hash) return json({ ok: false, reason: "evidence unavailable" }, 503);
    const evidence = JSON.parse(evidenceText) as { admission: { payload: string }; receipts: unknown[] };
    const decision = JSON.parse(evidence.admission.payload) as { verdict: { pass: boolean; passed: number } };
    return json({ ok: true, evidenceHash: session.evidence_hash, admission: evidence.admission, receipts: evidence.receipts, verdict: decision.verdict.pass, passed: decision.verdict.passed }, status);
  }

  private async submitSession(req: Request, sessionId: string): Promise<Response> {
    const parsed = await this.body(req);
    if (!parsed) return json({ ok: false, reason: "invalid body" }, 400);
    const actor = await this.authenticate(req, parsed.bytes);
    if (!actor) return json({ ok: false, reason: "unauthorized" }, 401);
    const session = [...this.ctx.storage.sql.exec<SessionRow>("SELECT * FROM sessions WHERE id = ?", sessionId)][0];
    if (!session) return json({ ok: false, reason: "not found" }, 404);
    if (session.decided_at) return this.decidedResponse(session);
    if (!session.sealed_ticket) return json({ ok: false, reason: "session unavailable" }, 503);
    const secret = await openJson<HostedSessionSecret>(session.sealed_ticket, `session:${actor.address}:${session.id}`, this.env.SESSION_WRAP_KEY, this.env.ENVIRONMENT);
    const responses = parsed.value.responses;
    const subjectProof = parsed.value.subjectProof;
    if (!responses || typeof responses !== "object" || Array.isArray(responses) || !subjectProof || typeof subjectProof !== "object" || Array.isArray(subjectProof)) return json({ ok: false, reason: "invalid body" }, 400);
    const proof = subjectProof as { publicKey?: unknown; signature?: unknown };
    if (typeof proof.publicKey !== "string" || typeof proof.signature !== "string") return json({ ok: false, reason: "invalid body" }, 400);
    const now = new Date();
    let result;
    try {
      result = await submitHostedSession({ session: secret, responses: responses as Record<string, string>, subjectProof: { publicKey: proof.publicKey, signature: proof.signature }, actorPublicKey: actor.public_key, issuer: await issuerIdentity(this.env.ISSUER_JWK, this.env.ENVIRONMENT), now });
    } catch (error) {
      return json({ ok: false, reason: error instanceof Error && error.message === "session expired" ? "session expired" : "submission rejected" }, error instanceof Error && error.message === "session expired" ? 410 : 400);
    }
    const evidence = { protocol: "clankdar-hosted-evidence-v1", actor: actor.address, campaignId: secret.campaignId, epoch: secret.epoch, admission: result.admission, receipts: result.receipts };
    const evidenceText = canonical(evidence);
    const evidenceHash = await sha256(evidenceText);
    if (new TextEncoder().encode(evidenceText).byteLength > MAX_EVIDENCE_BYTES) return json({ ok: false, reason: "evidence too large" }, 413);
    const latency = Math.max(0, now.getTime() - Date.parse(secret.issuedAt));
    await this.appendEvent("epoch-decided", { campaignId: secret.campaignId, epoch: secret.epoch, sessionId, evidenceHash, passed: result.passed, required: secret.policy.minPass, verdict: result.verdict, latencyMs: latency }, now.toISOString(), () => {
      // Freeze the only decision and its exact public bytes before network IO.
      this.ctx.storage.sql.exec("UPDATE sessions SET decided_at = ?, evidence_hash = ?, sealed_ticket = NULL WHERE id = ? AND decided_at IS NULL", now.toISOString(), evidenceHash, session.id);
      this.ctx.storage.sql.exec("UPDATE campaign_epochs SET status = 'decided', evidence_hash = ?, passed = ?, verdict = ?, latency_ms = ? WHERE campaign_id = ? AND epoch = ? AND status = 'issued'", evidenceHash, result.passed, result.verdict ? 1 : 0, latency, secret.campaignId, secret.epoch);
      this.ctx.storage.sql.exec("UPDATE campaigns SET cursor = ? WHERE id = ?", secret.epoch + 1, secret.campaignId);
      this.ctx.storage.sql.exec("INSERT INTO evidence_outbox (evidence_hash, evidence_text) VALUES (?, ?)", evidenceHash, evidenceText);
    });
    const campaign = [...this.ctx.storage.sql.exec<CampaignRow>("SELECT * FROM campaigns WHERE id = ?", secret.campaignId)][0]!;
    await this.finalizeCampaign(campaign, actor, now.toISOString());
    return this.decidedResponse({ ...session, decided_at: now.toISOString(), evidence_hash: evidenceHash, sealed_ticket: null }, 201);
  }

  private async profile(): Promise<Response> {
    const actor = this.actor();
    if (!actor) return json({ ok: false, reason: "not found" }, 404);
    await this.flushOutbox();
    const active = [...this.ctx.storage.sql.exec<CampaignRow>("SELECT * FROM campaigns WHERE completed_at IS NULL ORDER BY created_at LIMIT 4")];
    for (const campaign of active) await this.materializeMisses(campaign, actor, new Date(), 2);
    const totals = [...this.ctx.storage.sql.exec<{ events: number; heartbeats: number }>("SELECT count(*) AS events, sum(CASE WHEN type = 'heartbeat' THEN 1 ELSE 0 END) AS heartbeats FROM events")][0];
    const head = [...this.ctx.storage.sql.exec<{ seq: number; event_hash: string; issuer_payload: string; issuer_signature: string }>("SELECT seq, event_hash, issuer_payload, issuer_signature FROM events ORDER BY seq DESC LIMIT 1")][0];
    const rows = [...this.ctx.storage.sql.exec<CampaignRow>("SELECT * FROM campaigns ORDER BY created_at DESC LIMIT ?", MAX_CAMPAIGNS)];
    const summaries = await Promise.all(rows.map((row) => this.campaignPublic(row)));
    const completed = summaries.reduce((sum, campaign) => sum + campaign.evidence.completed, 0);
    const missed = summaries.reduce((sum, campaign) => sum + campaign.evidence.missed, 0);
    const scheduled = summaries.reduce((sum, campaign) => sum + campaign.evidence.scheduled, 0);
    const pendingEvidence = [...this.ctx.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM evidence_outbox")][0]!.count;
    this.project();
    return json({
      protocol: "clankdar-actor-v1", address: actor.address, publicKey: actor.public_key, createdAt: actor.created_at,
      evidence: { events: totals?.events ?? 0, heartbeats: totals?.heartbeats ?? 0, campaigns: rows.length, scheduledEpochs: scheduled, completedEpochs: completed, missedEpochs: missed, pendingEpochs: scheduled - completed - missed, pendingEvidence },
      campaigns: summaries.slice(0, 20),
      head: head ? { seq: head.seq, eventHash: head.event_hash, payload: head.issuer_payload, signature: head.issuer_signature } : null,
      claims: {
        keyContinuity: true,
        automatedAvailability: completed + missed > 0 ? { completed, missed, rate: completed / (completed + missed) } : null,
        capability: completed > 0 ? { admitted: summaries.reduce((sum, campaign) => sum + campaign.evidence.admitted, 0), epochs: completed, challengesPassed: summaries.reduce((sum, campaign) => sum + campaign.evidence.challengesPassed, 0) } : null,
        modelIdentity: false, unique: false,
      },
    });
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
    const body = await readBody(req, 4096);
    if (!body) return json({ ok: false, reason: "body too large" }, 413);
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
    const total = [...this.ctx.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM events WHERE type = 'heartbeat'")][0]!.count;
    if (total >= 4096) return json({ ok: false, reason: "staging heartbeat capacity reached" }, 429);
    const event = await this.appendEvent("heartbeat", note === undefined ? {} : { note }, at);
    return json({ ok: true, address: actor.address, seq: event.seq, eventHash: event.event_hash }, 201);
  }

  async fetch(req: Request): Promise<Response> {
    let release!: () => void;
    const preceding = this.requestTail;
    this.requestTail = new Promise<void>((resolve) => { release = resolve; });
    await preceding;
    try { return await this.route(req); }
    catch { return json({ ok: false, reason: "service unavailable" }, 503); }
    finally { release(); }
  }

  private async route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/internal/initialize") return this.initialize(req);
    if (req.method === "GET" && url.pathname.endsWith("/events")) return this.events(url);
    const campaign = /\/campaigns\/(cmp_[A-Za-z0-9_-]{16})(\/next)?$/.exec(url.pathname);
    if (req.method === "GET" && campaign?.[2] === "/next") return this.nextEpoch(req, campaign[1]);
    if (req.method === "GET" && campaign) return this.campaign(campaign[1], url);
    if (req.method === "POST" && url.pathname.endsWith("/campaigns")) return this.createCampaign(req);
    const session = /\/sessions\/(gs_[A-Za-z0-9_-]{12})$/.exec(url.pathname);
    if (req.method === "POST" && session) return this.submitSession(req, session[1]);
    if (req.method === "GET") return this.profile();
    if (req.method === "POST" && url.pathname.endsWith("/heartbeat")) return this.heartbeat(req);
    return json({ ok: false, reason: "not found" }, 404);
  }
}
