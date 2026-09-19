import { renderActorProfile, renderCampaignProfile } from "./public.ts";
import { ActorState } from "./actor.ts";
import { actorAddress, registrationTranscript, REQUEST_NONCE, sha256Bytes, SIGNATURE, timestampCurrent, verifyActorSignature } from "./protocol.ts";
import { issuerIdentity } from "./issuer.ts";
import { HOSTED_POLICIES } from "./challenges.ts";
import type { Env } from "./types.ts";
import { readBody } from "./http.ts";

export { ActorState };

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), { status, headers: { ...JSON_HEADERS, ...headers } });
const MAX_REGISTRATION_BYTES = 4096;
const encoder = new TextEncoder();

async function sameSecret(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Bytes(encoder.encode(left)), sha256Bytes(encoder.encode(right))]);
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
  return different === 0;
}

async function boundedJson(req: Request, cap: number): Promise<Record<string, unknown> | null> {
  const body = await readBody(req, cap);
  if (!body) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(body));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function register(req: Request, env: Env): Promise<Response> {
  if (!env.REGISTRATION_TOKEN) return json({ ok: false, reason: "registration unavailable" }, 503);
  const bearer = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!await sameSecret(bearer, env.REGISTRATION_TOKEN)) return json({ ok: false, reason: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  const body = await boundedJson(req, MAX_REGISTRATION_BYTES);
  if (!body) return json({ ok: false, reason: "invalid body" }, 400);
  const publicKey = typeof body.publicKey === "string" ? body.publicKey : "";
  const timestamp = typeof body.timestamp === "string" ? body.timestamp : "";
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  if (!REQUEST_NONCE.test(nonce) || !SIGNATURE.test(signature) || !timestampCurrent(timestamp)) return json({ ok: false, reason: "registration proof does not verify" }, 401);
  let address: string;
  try { address = await actorAddress(publicKey); } catch { return json({ ok: false, reason: "registration proof does not verify" }, 401); }
  if (!await verifyActorSignature(publicKey, registrationTranscript(publicKey, timestamp, nonce), signature)) return json({ ok: false, reason: "registration proof does not verify" }, 401);
  // Reserve the bounded directory slot before creating any Durable Object.
  // Retaining a failed reservation makes retries safe and prevents unindexed objects.
  const createdAt = new Date().toISOString();
  await env.REGISTRY.prepare(`
    INSERT OR IGNORE INTO actors (address, public_key, created_at, last_seen_at, event_count)
    SELECT ?, ?, ?, ?, 1 WHERE (SELECT count(*) FROM actors) < 25
  `).bind(address, publicKey, createdAt, createdAt).run();
  const indexed = await env.REGISTRY.prepare("SELECT public_key, created_at FROM actors WHERE address = ?").bind(address).first<{ public_key: string; created_at: string }>();
  if (!indexed) return json({ ok: false, reason: "staging actor capacity reached" }, 429);
  if (indexed.public_key !== publicKey) return json({ ok: false, reason: "address conflict" }, 409);
  const initialized = await env.ACTORS.getByName(address).fetch(new Request("https://actor.internal/internal/initialize", {
    method: "POST", headers: { "content-type": "application/json", "x-clankdar-internal": "initialize" },
    body: JSON.stringify({ address, publicKey, createdAt: indexed.created_at }),
  }));
  if (initialized.status === 409) return json({ ok: false, reason: "address conflict" }, 409);
  if (!initialized.ok) return json({ ok: false, reason: "actor registry unavailable" }, 503);
  return json({ ok: true, address, publicKey, createdAt: indexed.created_at }, initialized.status === 201 ? 201 : 200, { location: `/v1/actors/${address}` });
}

async function listActors(url: URL, env: Env): Promise<Response> {
  const after = url.searchParams.get("after") ?? "";
  const limitRaw = url.searchParams.get("limit") ?? "50";
  if (!/^\d+$/.test(limitRaw)) return json({ ok: false, reason: "invalid page" }, 400);
  const limit = Math.min(Number(limitRaw), 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || (after && !/^clank1_[A-Za-z0-9_-]{27}$/.test(after))) return json({ ok: false, reason: "invalid page" }, 400);
  const result = await env.REGISTRY.prepare(`
    SELECT address, public_key AS publicKey, created_at AS createdAt, last_seen_at AS lastSeenAt, event_count AS eventCount
    FROM actors WHERE address > ? ORDER BY address LIMIT ?
  `).bind(after, limit).all();
  const actors = result.results;
  return json({ ok: true, actors, next: actors.length === limit ? (actors.at(-1) as { address: string }).address : null }, 200, { "cache-control": "public, max-age=10" });
}

async function actorRoute(req: Request, url: URL, env: Env): Promise<Response> {
  const match = /^\/v1\/actors\/(clank1_[A-Za-z0-9_-]{27})(\/.*)?$/.exec(url.pathname);
  if (!match) return json({ ok: false, reason: "not found" }, 404);
  const address = match[1];
  const suffix = match[2] ?? "";
  const get = suffix === "" || suffix === "/events" || /^\/campaigns\/cmp_[A-Za-z0-9_-]{16}(?:\/next)?$/.test(suffix);
  const post = suffix === "/heartbeat" || suffix === "/campaigns" || /^\/sessions\/gs_[A-Za-z0-9_-]{12}$/.test(suffix);
  if ((req.method === "GET" && !get) || (req.method === "POST" && !post) || (req.method !== "GET" && req.method !== "POST")) return json({ ok: false, reason: "not found" }, 404);
  const indexed = await env.REGISTRY.prepare("SELECT 1 AS present FROM actors WHERE address = ?").bind(address).first();
  if (!indexed) return json({ ok: false, reason: "not found" }, 404);
  // Keep slow or oversized unauthenticated streams outside the actor request queue.
  const body = req.method === "POST" ? await readBody(req, 131_072) : undefined;
  if (body === null) return json({ ok: false, reason: "invalid body" }, 413);
  return env.ACTORS.getByName(address).fetch(new Request(`https://actor.internal${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body }));
}

async function workerFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const profile = /^\/actors\/(clank1_[A-Za-z0-9_-]{27})(?:\/campaigns\/(cmp_[A-Za-z0-9_-]{16}))?$/.exec(url.pathname);
  if (req.method === "GET" && profile) {
    const apiUrl = new URL(`/v1${url.pathname}`, url.origin);
    apiUrl.search = url.search;
    const result = await actorRoute(new Request(apiUrl), apiUrl, env);
    if (!result.ok) return result;
    const data = await result.json() as Record<string, any>;
    return profile[2] ? renderCampaignProfile(data.campaign, profile[1], data.campaign.epochsPage?.epochs ?? []) : renderActorProfile(data);
  }
  if ((req.method === "GET" || req.method === "HEAD") && env.ASSETS && (/^\/(?:design|marks)\//.test(url.pathname) || ["/icon.png", "/styles.css", "/profile.css", "/footer.css", "/appearance.js"].includes(url.pathname))) return env.ASSETS.fetch(req);
  if (req.method === "GET" && url.pathname === "/healthz") {
    try {
      await env.REGISTRY.prepare("SELECT 1").first();
      return json({ ok: true, service: "clankdar-hosted", environment: env.ENVIRONMENT });
    } catch {
      return json({ ok: false, reason: "storage unavailable" }, 503);
    }
  }
  if (req.method === "GET" && url.pathname === "/v1/issuer") {
    try {
      const issuer = await issuerIdentity(env.ISSUER_JWK, env.ENVIRONMENT);
      return json({ protocol: "clankdar-hosted-v1", verifier: { keyId: issuer.keyId, publicKey: issuer.publicKey }, actorProtocol: "clankdar-actor-v1" }, 200, { "cache-control": "public, max-age=300" });
    } catch {
      return json({ ok: false, reason: "issuer unavailable" }, 503);
    }
  }
  if (req.method === "GET" && url.pathname === "/v1/policies") return json({ ok: true, policies: Object.values(HOSTED_POLICIES) }, 200, { "cache-control": "public, max-age=300" });
  if (req.method === "GET" && url.pathname.startsWith("/v1/policies/")) {
    const policy = HOSTED_POLICIES[url.pathname.slice("/v1/policies/".length)];
    return policy ? json({ ok: true, policy }, 200, { "cache-control": "public, max-age=31536000, immutable" }) : json({ ok: false, reason: "not found" }, 404);
  }
  if (req.method === "POST" && url.pathname === "/v1/actors") return register(req, env);
  if (req.method === "GET" && url.pathname === "/v1/actors") return listActors(url, env);
  if (url.pathname.startsWith("/v1/actors/")) return actorRoute(req, url, env);
  if (req.method === "GET" && /^\/v1\/evidence\/[0-9a-f]{64}$/.test(url.pathname)) {
    const hash = url.pathname.slice("/v1/evidence/".length);
    const object = await env.EVIDENCE.get(`sha256/${hash}.json`);
    if (!object) return json({ ok: false, reason: "not found" }, 404);
    return new Response(object.body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=31536000, immutable", etag: `"${hash}"` } });
  }
  return json({ ok: false, reason: "not found" }, 404);
}

export default {
  async fetch(req, env): Promise<Response> {
    try { return await workerFetch(req, env); } catch { return json({ ok: false, reason: "service unavailable" }, 503); }
  },
} satisfies ExportedHandler<Env>;
