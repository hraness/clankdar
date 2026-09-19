import { SELF, env, listDurableObjectIds } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { handleCheckRequest } from "../src/checks.ts";
import { type CheckSessionSecret } from "../src/challenges.ts";
import { issuerIdentity } from "../src/issuer.ts";
import { b64url, canonical, sha256 } from "../src/protocol.ts";
import { openJson, sealJson } from "../src/seal.ts";
import type { Env } from "../src/types.ts";

interface Issued { id: string; ticket: string; challenges: { challengeId: string }[]; expiresAt: string; receiptUrl: string }
const origin = "https://example.test";
const encoder = new TextEncoder();
const at = new Date("2026-09-19T12:00:00.000Z");
const post = (path: string, value: unknown, invited = false) => new Request(`${origin}${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...(invited ? { authorization: "Bearer test-registration" } : {}) }, body: JSON.stringify(value),
});
const call = (request: Request, options: { environment?: Env; now?: Date } = {}) => handleCheckRequest(request, options.environment ?? env, () => options.now ?? at);
async function create(value: unknown = {}, options: { environment?: Env; now?: Date } = {}): Promise<Issued> {
  const response = await call(post("/v1/checks", value, true), options);
  expect(response.status).toBe(201);
  return response.json() as Promise<Issued>;
}
const submit = (issued: Issued, responses: Record<string, string> = {}, extra: Record<string, unknown> = {}) => post(`/v1/checks/${issued.id}/responses`, { ticket: issued.ticket, responses, ...extra });
async function ticketContents(issued: Issued) {
  const issuer = await issuerIdentity("test", "test");
  const aad = canonical(["clankdar-check-ticket-v1", "test", issuer.publicKey, issued.id]);
  return { aad, envelope: await openJson<{ protocol: string; session: CheckSessionSecret }>(issued.ticket, aad, "test", "test") };
}
async function answers(issued: Issued) {
  const { envelope } = await ticketContents(issued);
  return Object.fromEntries(envelope.session.tickets.map((ticket) => [ticket.challenge.challengeId, ticket.expected]));
}
async function subject() {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicKey = (await crypto.subtle.exportKey("jwk", keys.publicKey) as JsonWebKey).x!;
  return { publicKey, proof: async (id: string) => ({ publicKey, signature: b64url(await crypto.subtle.sign("Ed25519", keys.privateKey, encoder.encode(canonical(["clankdar/subject/v1", id, publicKey])))) }) };
}
function evidenceWith(overrides: Partial<Pick<R2Bucket, "get" | "put">>): Env {
  return { ...env, EVIDENCE: { get: env.EVIDENCE.get.bind(env.EVIDENCE), put: env.EVIDENCE.put.bind(env.EVIDENCE), ...overrides } as R2Bucket };
}

beforeEach(async () => {
  // Test-owned additive counter only; never reset actor or legacy evidence data.
  await env.REGISTRY.prepare("UPDATE check_issuance_budget SET issued_total = 0, minute_started = 0, minute_issued = 0 WHERE singleton = 1").run();
});

describe("Atomic standalone checks", () => {
  test("public routes preserve exact canonical receipt bytes without creating actor or session state", async () => {
    const beforeActors = await env.REGISTRY.prepare("SELECT count(*) AS n FROM actors").first();
    const beforeObjects = (await listDurableObjectIds(env.ACTORS)).map(String).sort();
    const issuedResponse = await SELF.fetch(post("/v1/checks", { context: "job:42" }, true));
    expect(issuedResponse.status).toBe(201);
    const issued = await issuedResponse.json() as Issued;
    expect((issued as any).policyId).toBe("algal-floor-v1");
    expect(issued.challenges.every((challenge: any) => challenge.suiteVersion === "clankdar-algal-v1" && challenge.family === "algal")).toBe(true);
    expect(issued.id).toMatch(/^gs_[A-Za-z0-9_-]{12}$/);
    expect(issued.receiptUrl).toBe(`/v1/checks/${issued.id}`);
    expect((await SELF.fetch(`${origin}${issued.receiptUrl}`)).status).toBe(404);
    const resultResponse = await SELF.fetch(submit(issued, await answers(issued)));
    expect(resultResponse.status).toBe(201);
    const result = await resultResponse.json() as any;
    expect(result).toMatchObject({ ok: true, id: issued.id, pass: true, passed: 4, required: 3 });
    expect(result.receipts).toBeUndefined();
    const read = await SELF.fetch(`${origin}${issued.receiptUrl}`);
    const text = await read.text();
    expect(text).toBe(canonical(result.receipt));
    expect(result.sha256).toBe(await sha256(text));
    expect(read.headers.get("etag")).toBe(`"${result.sha256}"`);
    expect(read.headers.get("cache-control")).toContain("immutable");
    expect(JSON.parse(result.receipt.payload)).toMatchObject({ kind: "admission", sessionId: issued.id, context: "job:42" });
    expect(JSON.parse(result.receipt.payload).subject).toBeUndefined();
    expect((await env.EVIDENCE.list({ prefix: `checks/${issued.id}` })).objects.map((object) => object.key)).toEqual([`checks/${issued.id}.json`]);
    expect(await env.EVIDENCE.get(`sha256/${result.sha256}.json`)).toBeNull();
    expect(await env.REGISTRY.prepare("SELECT count(*) AS n FROM actors").first()).toEqual(beforeActors);
    expect((await listDurableObjectIds(env.ACTORS)).map(String).sort()).toEqual(beforeObjects);
    expect(await env.REGISTRY.prepare("SELECT issued_total FROM check_issuance_budget").first()).toEqual({ issued_total: 1 });
  });

  test.each(["v2-floor-v1", "frontier-floor-v1"])("explicit legacy policy %s remains independently available", async (policyId) => {
    const issued = await create({ policyId });
    expect((issued as any).policyId).toBe(policyId);
    expect(issued.challenges.every((challenge: any) => challenge.family !== "algal")).toBe(true);
    const response = await call(submit(issued, await answers(issued)));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ pass: true, passed: 4, required: 3 });
  });

  test("different concurrent submissions return the single conditional-write winner", async () => {
    const issued = await create();
    const correct = await answers(issued);
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    const environment = evidenceWith({ get: (async (...args: Parameters<R2Bucket["get"]>) => {
      const result = await env.EVIDENCE.get(...args);
      if (++reads <= 2) { if (reads === 2) release(); await bothRead; }
      return result;
    }) as R2Bucket["get"] });
    const responses = await Promise.all([call(submit(issued, correct), { environment }), call(submit(issued), { environment })]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    const results = await Promise.all(responses.map((response) => response.json()));
    expect(results[0]).toEqual(results[1]);
    const result = results[0] as any;
    expect(await (await env.EVIDENCE.get(`checks/${issued.id}.json`))!.text()).toBe(canonical(result.receipt));
    expect(await (await call(submit(issued, correct))).json()).toEqual(result);
  });

  test("a write that fails before commit returns no candidate and can be retried", async () => {
    const issued = await create();
    const environment = evidenceWith({ put: (async () => { throw new Error("test write unavailable"); }) as R2Bucket["put"] });
    const failed = await call(submit(issued), { environment });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ ok: false, reason: "receipt commit unavailable", retryable: true });
    expect((await call(new Request(`${origin}${issued.receiptUrl}`))).status).toBe(404);
    const accepted = await call(submit(issued, await answers(issued)));
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ pass: true, passed: 4 });
  });

  test("a lost successful-write acknowledgement recovers the persisted bytes, including after expiry", async () => {
    const issued = await create();
    const environment = evidenceWith({ put: (async (...args: Parameters<R2Bucket["put"]>) => {
      await env.EVIDENCE.put(...args);
      throw new Error("test acknowledgement lost");
    }) as R2Bucket["put"] });
    const recovered = await call(submit(issued), { environment });
    expect(recovered.status).toBe(200);
    const frozen = await recovered.json();
    const expired = await call(submit(issued, await answers(issued)), { now: new Date(Date.parse(issued.expiresAt) + 1) });
    expect(expired.status).toBe(200);
    expect(await expired.json()).toEqual(frozen);
  });

  test("uncommitted expired tickets cannot produce a result, and missing conditional-write winners are retryable", async () => {
    const issued = await create();
    const failed = await call(submit(issued), { environment: evidenceWith({ put: (async () => null) as unknown as R2Bucket["put"] }) });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ retryable: true });
    expect((await call(submit(issued), { now: new Date(Date.parse(issued.expiresAt) + 1) })).status).toBe(410);
    expect((await call(new Request(`${origin}${issued.receiptUrl}`))).status).toBe(404);
  });

  test("ticket authentication rejects changed ciphertext, another id, environment, issuer, or protocol", async () => {
    const issued = await create();
    const other = await create();
    const index = 50;
    const modified = issued.ticket.slice(0, index) + (issued.ticket[index] === "A" ? "B" : "A") + issued.ticket.slice(index + 1);
    expect((await call(submit(issued, {}, { ticket: modified }))).status).toBe(401);
    expect((await call(submit(other, {}, { ticket: issued.ticket }))).status).toBe(401);
    const { envelope } = await ticketContents(issued);
    const issuer = await issuerIdentity("test", "test");
    for (const aad of [
      canonical(["clankdar-check-ticket-v1", "another-environment", issuer.publicKey, issued.id]),
      canonical(["clankdar-check-ticket-v1", "test", "another-issuer", issued.id]),
      canonical(["another-protocol", "test", issuer.publicKey, issued.id]),
    ]) {
      const ticket = await sealJson(envelope, aad, "test", "test");
      expect((await call(submit(issued, {}, { ticket }))).status).toBe(401);
    }
    expect((await call(new Request(`${origin}${issued.receiptUrl}`))).status).toBe(404);
  });

  test("authenticated tickets still enforce policy, deadline, binding and generator integrity", async () => {
    const issued = await create();
    const original = await ticketContents(issued);
    for (const mutate of [
      (value: any) => { value.session.policy.minPass = 0; },
      (value: any) => { value.session.expiresAt = new Date(Date.parse(value.session.expiresAt) + 1).toISOString(); },
      (value: any) => { value.session.tickets[0].challenge.context = "different"; },
      (value: any) => { value.session.tickets[0].challenge.verifier.publicKey = "different"; },
    ]) {
      const envelope = structuredClone(original.envelope);
      mutate(envelope);
      const ticket = await sealJson(envelope, original.aad, "test", "test");
      expect((await call(submit(issued, {}, { ticket }))).status).toBe(401);
    }
    const envelope = structuredClone(original.envelope);
    envelope.session.tickets[0].seed = (envelope.session.tickets[0].seed ^ 1) >>> 0;
    const ticket = await sealJson(envelope, original.aad, "test", "test");
    expect((await call(submit(issued, {}, { ticket }))).status).toBe(503);
    expect(await env.EVIDENCE.get(`checks/${issued.id}.json`)).toBeNull();
  });

  test("requested subject proof is mandatory and still checked before recovering a committed result", async () => {
    const owner = await subject();
    const stranger = await subject();
    const issued = await create({ subjectPublicKey: owner.publicKey, context: "owner-task" });
    expect((await call(submit(issued))).status).toBe(401);
    expect((await call(submit(issued, {}, { subjectProof: await stranger.proof(issued.id) }))).status).toBe(401);
    expect((await call(submit(issued, {}, { subjectProof: { publicKey: owner.publicKey, signature: "bad" } }))).status).toBe(401);
    const proof = await owner.proof(issued.id);
    const response = await call(submit(issued, await answers(issued), { subjectProof: proof }));
    expect(response.status).toBe(201);
    const result = await response.json() as any;
    const payload = JSON.parse(result.receipt.payload);
    expect(payload.subject).toBe(owner.publicKey);
    expect(payload.challenges.every((challenge: any) => challenge.subject === owner.publicKey)).toBe(true);
    expect(payload.receipts.every((receipt: any) => JSON.parse(receipt.payload).subjectProof.publicKey === owner.publicKey)).toBe(true);
    expect((await call(submit(issued), { now: new Date(Date.parse(issued.expiresAt) + 1) })).status).toBe(401);
    expect((await call(submit(issued, {}, { subjectProof: proof }), { now: new Date(Date.parse(issued.expiresAt) + 1) })).status).toBe(200);
  });

  test("unbound checks need no key, but any supplied proof must verify", async () => {
    const issued = await create();
    const owner = await subject();
    expect((await call(submit(issued, {}, { subjectProof: { publicKey: owner.publicKey, signature: "bad" } }))).status).toBe(401);
    const response = await call(submit(issued, await answers(issued), { subjectProof: await owner.proof(issued.id) }));
    expect(response.status).toBe(201);
    const payload = JSON.parse((await response.json() as any).receipt.payload);
    expect(payload.subject).toBeUndefined();
    expect(payload.receipts.every((receipt: any) => JSON.parse(receipt.payload).subjectProof.publicKey === owner.publicKey)).toBe(true);
  });

  test("atomic issuance counters enforce lifetime and minute races without backward resets", async () => {
    const minute = Math.floor(at.getTime() / 60_000);
    await env.REGISTRY.prepare("UPDATE check_issuance_budget SET issued_total = 1023, minute_started = ?, minute_issued = 0").bind(minute).run();
    let responses = await Promise.all(Array.from({ length: 4 }, () => call(post("/v1/checks", {}, true))));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 429, 429, 429]);
    expect(await env.REGISTRY.prepare("SELECT issued_total FROM check_issuance_budget").first()).toEqual({ issued_total: 1024 });
    await env.REGISTRY.prepare("UPDATE check_issuance_budget SET issued_total = 0, minute_started = ?, minute_issued = 59").bind(minute).run();
    responses = await Promise.all(Array.from({ length: 4 }, () => call(post("/v1/checks", {}, true))));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 429, 429, 429]);
    expect((await call(post("/v1/checks", {}, true), { now: new Date(at.getTime() + 60_000) })).status).toBe(201);
    expect((await call(post("/v1/checks", {}, true), { now: at })).status).toBe(429);
    expect(await env.REGISTRY.prepare("SELECT issued_total, minute_started, minute_issued FROM check_issuance_budget").first()).toEqual({ issued_total: 2, minute_started: minute + 1, minute_issued: 1 });
  });

  test("auth and invalid inputs consume no issuance slots; failed issuance conservatively consumes one", async () => {
    expect((await call(post("/v1/checks", {}))).status).toBe(401);
    for (const value of [{ policyId: "constructor" }, { context: " " }, { context: "x".repeat(257) }, { subjectPublicKey: "invalid" }, { unknown: true }]) {
      expect((await call(post("/v1/checks", value, true))).status).toBe(400);
    }
    expect(await env.REGISTRY.prepare("SELECT issued_total FROM check_issuance_budget").first()).toEqual({ issued_total: 0 });
    expect((await call(post("/v1/checks", {}, true), { environment: { ...env, SESSION_WRAP_KEY: "invalid" } })).status).toBe(503);
    expect(await env.REGISTRY.prepare("SELECT issued_total FROM check_issuance_budget").first()).toEqual({ issued_total: 1 });
  });

  test("request bounds and response IDs fail closed", async () => {
    expect((await call(post("/v1/checks", { context: "x".repeat(4096) }, true))).status).toBe(413);
    const issued = await create();
    expect((await call(submit(issued, { unknown: "answer" }))).status).toBe(400);
    expect((await call(submit(issued, { [issued.challenges[0].challengeId]: "x".repeat(65_537) }))).status).toBe(400);
    expect((await call(submit(issued, {}, { extra: "x".repeat(131_072) }))).status).toBe(413);
    expect(await env.EVIDENCE.get(`checks/${issued.id}.json`)).toBeNull();
  });
});
