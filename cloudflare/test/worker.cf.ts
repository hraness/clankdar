import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { actorAddress, b64url, canonical, registrationTranscript, requestTranscript, unb64url } from "../src/protocol.ts";
import { scheduleCommit } from "../src/campaign.ts";
import { openJson } from "../src/seal.ts";
import { readBody } from "../src/http.ts";

const encoder = new TextEncoder();

async function actor() {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey) as JsonWebKey;
  const publicKey = publicJwk.x!;
  const address = await actorAddress(publicKey);
  const sign = async (transcript: unknown) => b64url(await crypto.subtle.sign("Ed25519", keys.privateKey, encoder.encode(canonical(transcript))));
  return { keys, publicKey, address, sign };
}

async function registration(identity: Awaited<ReturnType<typeof actor>>, over: Record<string, unknown> = {}) {
  const timestamp = new Date().toISOString();
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const signature = await identity.sign(registrationTranscript(identity.publicKey, timestamp, nonce));
  return { publicKey: identity.publicKey, timestamp, nonce, signature, ...over };
}

async function signedRequest(identity: Awaited<ReturnType<typeof actor>>, path: string, body?: unknown, reuse?: { timestamp: string; nonce: string; signature: string }, method = "POST") {
  const bytes = method === "GET" ? new Uint8Array() : encoder.encode(JSON.stringify(body ?? {}));
  const timestamp = reuse?.timestamp ?? new Date().toISOString();
  const nonce = reuse?.nonce ?? b64url(crypto.getRandomValues(new Uint8Array(18)));
  const signature = reuse?.signature ?? await identity.sign(await requestTranscript(identity.address, identity.publicKey, timestamp, nonce, method, path, bytes));
  const headers = { "content-type": "application/json", "x-clankdar-timestamp": timestamp, "x-clankdar-nonce": nonce, "x-clankdar-signature": signature };
  return { request: new Request(`https://example.test${path}`, { method, headers, body: method === "GET" ? undefined : bytes }), auth: { timestamp, nonce, signature } };
}

async function registeredActor() {
  const identity = await actor();
  expect((await SELF.fetch("https://example.test/v1/actors", {
    method: "POST", headers: { authorization: "Bearer test-registration" }, body: JSON.stringify(await registration(identity)),
  })).status).toBe(201);
  return identity;
}

async function startCampaign(identity: Awaited<ReturnType<typeof actor>>, epochs = 1) {
  const path = `/v1/actors/${identity.address}/campaigns`;
  const created = await SELF.fetch((await signedRequest(identity, path, { policyId: "v2-floor-v1", epochs, cadenceSeconds: 60, windowSeconds: 60, startDelaySeconds: 0 })).request);
  expect(created.status).toBe(201);
  return (await created.json() as any).campaign;
}

describe("Cloudflare hosted actor foundation", () => {
  test("registers a key-addressed actor, authenticates mutations, and publishes a signed chain", async () => {
    const identity = await actor();
    const registered = await SELF.fetch("https://example.test/v1/actors", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-registration" }, body: JSON.stringify(await registration(identity)) });
    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({ ok: true, address: identity.address, publicKey: identity.publicKey });
    expect(registered.headers.get("location")).toBe(`/v1/actors/${identity.address}`);

    const again = await SELF.fetch("https://example.test/v1/actors", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-registration" }, body: JSON.stringify(await registration(identity)) });
    expect(again.status).toBe(200);

    const profile = await (await SELF.fetch(`https://example.test/v1/actors/${identity.address}`)).json() as any;
    expect(profile).toMatchObject({ protocol: "clankdar-actor-v1", address: identity.address, evidence: { events: 1, heartbeats: 0 }, claims: { keyContinuity: true, automatedAvailability: null, capability: null, modelIdentity: false, unique: false } });

    const path = `/v1/actors/${identity.address}/heartbeat`;
    const signed = await signedRequest(identity, path, { note: "online" });
    const heartbeat = await SELF.fetch(signed.request.clone());
    expect(heartbeat.status).toBe(201);
    expect(await heartbeat.json()).toMatchObject({ ok: true, address: identity.address, seq: 2 });

    const replay = await SELF.fetch(signed.request.clone());
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ ok: false, reason: "unauthorized" });

    const tampered = await signedRequest(identity, path, { note: "changed" }, signed.auth);
    expect((await SELF.fetch(tampered.request)).status).toBe(401);

    const eventsResponse = await SELF.fetch(`https://example.test/v1/actors/${identity.address}/events?after=0&limit=10`);
    const events = await eventsResponse.json() as any;
    expect(events.events).toHaveLength(2);
    expect(events.events[0]).toMatchObject({ seq: 1, type: "registered", previousHash: "0".repeat(64) });
    expect(events.events[1]).toMatchObject({ seq: 2, type: "heartbeat", previousHash: events.events[0].eventHash });
    expect(events.next).toBeNull();

    const issuer = await (await SELF.fetch("https://example.test/v1/issuer")).json() as any;
    const key = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: issuer.verifier.publicKey }, { name: "Ed25519" }, false, ["verify"]);
    for (const event of events.events) {
      expect(await crypto.subtle.verify("Ed25519", key, unb64url(event.envelope.signature), encoder.encode(event.envelope.payload))).toBe(true);
      expect(JSON.parse(event.envelope.payload).eventHash).toBe(event.eventHash);
    }

    const directory = await (await SELF.fetch("https://example.test/v1/actors?limit=10")).json() as any;
    expect(directory.actors).toContainEqual(expect.objectContaining({ address: identity.address, eventCount: 2 }));
  });

  test("precommits a cadence, issues one-use work, publishes R2 evidence, and reveals the completed schedule", async () => {
    const identity = await actor();
    const registered = await SELF.fetch("https://example.test/v1/actors", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-registration" }, body: JSON.stringify(await registration(identity)) });
    expect(registered.status).toBe(201);

    const campaignPath = `/v1/actors/${identity.address}/campaigns`;
    const create = await signedRequest(identity, campaignPath, { policyId: "v2-floor-v1", epochs: 1, cadenceSeconds: 60, windowSeconds: 60, startDelaySeconds: 0 });
    const createdResponse = await SELF.fetch(create.request);
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as any;
    expect(created.campaign).toMatchObject({ policyId: "v2-floor-v1", epochs: 1, evidence: { scheduled: 1, completed: 0, missed: 0 } });
    expect(created.campaign.scheduleSeed).toBeUndefined();

    const nextPath = `${campaignPath}/${created.campaign.campaignId}/next`;
    const next = await signedRequest(identity, nextPath, undefined, undefined, "GET");
    const issuedResponse = await SELF.fetch(next.request);
    expect(issuedResponse.status).toBe(201);
    const issued = await issuedResponse.json() as any;
    expect(issued).toMatchObject({ state: "issued", epoch: 0 });
    expect(issued.challenges).toHaveLength(4);
    expect(issued.challenges.every((challenge: any) => challenge.subject === identity.address && challenge.sessionId === issued.sessionId)).toBe(true);

    const subjectProof = {
      publicKey: identity.publicKey,
      signature: await identity.sign(["clankdar/subject/v1", issued.sessionId, identity.publicKey]),
    };
    const submitPath = `/v1/actors/${identity.address}/sessions/${issued.sessionId}`;
    const submit = await signedRequest(identity, submitPath, { responses: {}, subjectProof });
    const submittedResponse = await SELF.fetch(submit.request);
    expect(submittedResponse.status).toBe(201);
    const submitted = await submittedResponse.json() as any;
    expect(submitted).toMatchObject({ ok: true, verdict: false, passed: 0 });
    expect(submitted.receipts).toHaveLength(0);

    const evidenceResponse = await SELF.fetch(`https://example.test/v1/evidence/${submitted.evidenceHash}`);
    expect(evidenceResponse.status).toBe(200);
    expect(evidenceResponse.headers.get("cache-control")).toContain("immutable");
    const evidence = await evidenceResponse.json() as any;
    expect(evidence).toMatchObject({ protocol: "clankdar-hosted-evidence-v1", actor: identity.address, campaignId: created.campaign.campaignId, epoch: 0 });
    expect(evidence.admission).toEqual(submitted.admission);

    const replay = await signedRequest(identity, submitPath, { responses: {}, subjectProof });
    const recovered = await SELF.fetch(replay.request);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual(submitted);

    const campaign = await (await SELF.fetch(`https://example.test${campaignPath}/${created.campaign.campaignId}`)).json() as any;
    expect(campaign.campaign).toMatchObject({ completedAt: expect.any(String), evidence: { scheduled: 1, completed: 1, missed: 0, admitted: 0, challengesPassed: 0 } });
    expect(await scheduleCommit(created.campaign.campaignId, campaign.campaign.scheduleSeed)).toBe(created.campaign.scheduleCommit);

    const profile = await (await SELF.fetch(`https://example.test/v1/actors/${identity.address}`)).json() as any;
    expect(profile.claims).toMatchObject({ automatedAvailability: { completed: 1, missed: 0, rate: 1 }, capability: { admitted: 0, epochs: 1, challengesPassed: 0 }, modelIdentity: false, unique: false });
    const actorHtml = await SELF.fetch(`https://example.test/actors/${identity.address}`);
    expect(actorHtml.headers.get("content-type")).toContain("text/html");
    expect(actorHtml.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await actorHtml.text()).toContain(identity.address);
    const campaignHtml = await SELF.fetch(`https://example.test/actors/${identity.address}/campaigns/${created.campaign.campaignId}`);
    expect(await campaignHtml.text()).toContain(`/v1/evidence/${submitted.evidenceHash}`);
  });

  test("concurrent polls issue one session and concurrent submissions freeze one decision", async () => {
    const identity = await registeredActor();
    const campaign = await startCampaign(identity);
    const path = `/v1/actors/${identity.address}/campaigns/${campaign.campaignId}/next`;
    const polls = await Promise.all([signedRequest(identity, path, undefined, undefined, "GET"), signedRequest(identity, path, undefined, undefined, "GET")]);
    const issuedResponses = await Promise.all(polls.map((poll) => SELF.fetch(poll.request)));
    expect(issuedResponses.map((result) => result.status).sort()).toEqual([200, 201]);
    const issued = await Promise.all(issuedResponses.map((result) => result.json())) as any[];
    expect(issued[0].sessionId).toBe(issued[1].sessionId);
    const sessionId = issued[0].sessionId;
    const responses = await runInDurableObject(env.ACTORS.getByName(identity.address), async (_instance, state) => {
      const session = [...state.storage.sql.exec<{ sealed_ticket: string }>("SELECT sealed_ticket FROM sessions WHERE id = ?", sessionId)][0]!;
      const secret = await openJson<any>(session.sealed_ticket, `session:${identity.address}:${sessionId}`, "test", "test");
      return Object.fromEntries(secret.tickets.map((ticket: any) => [ticket.challenge.challengeId, ticket.expected]));
    });
    const subjectProof = { publicKey: identity.publicKey, signature: await identity.sign(["clankdar/subject/v1", sessionId, identity.publicKey]) };
    const submitPath = `/v1/actors/${identity.address}/sessions/${sessionId}`;
    const submissions = await Promise.all([signedRequest(identity, submitPath, { responses, subjectProof }), signedRequest(identity, submitPath, { responses: {}, subjectProof })]);
    const results = await Promise.all(submissions.map((submission) => SELF.fetch(submission.request)));
    expect(results.map((result) => result.status).sort()).toEqual([200, 201]);
    const decisions = await Promise.all(results.map((result) => result.json()));
    expect(decisions[0]).toEqual(decisions[1]);
    const history = await (await SELF.fetch(`https://example.test/v1/actors/${identity.address}/events`)).json() as any;
    expect(history.events.filter((event: any) => event.type === "epoch-issued")).toHaveLength(1);
    expect(history.events.filter((event: any) => event.type === "epoch-decided")).toHaveLength(1);
    expect(history.events.map((event: any) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < history.events.length; i++) expect(history.events[i].previousHash).toBe(history.events[i - 1].eventHash);
  });

  test("a failed event insert rolls back the associated issued session", async () => {
    const identity = await registeredActor();
    const campaign = await startCampaign(identity);
    const stub = env.ACTORS.getByName(identity.address);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("CREATE TRIGGER reject_issue BEFORE INSERT ON events WHEN NEW.type = 'epoch-issued' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    });
    const path = `/v1/actors/${identity.address}/campaigns/${campaign.campaignId}/next`;
    expect((await SELF.fetch((await signedRequest(identity, path, undefined, undefined, "GET")).request)).status).toBe(503);
    await runInDurableObject(stub, (_instance, state) => {
      expect([...state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM sessions")][0]!.count).toBe(0);
      expect([...state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM campaign_epochs")][0]!.count).toBe(0);
      state.storage.sql.exec("DROP TRIGGER reject_issue");
    });
    expect((await SELF.fetch((await signedRequest(identity, path, undefined, undefined, "GET")).request)).status).toBe(201);
  });

  test.each(["before-write", "after-write"])("an R2 failure %s preserves one frozen decision and retry publishes the same bytes", async (failure) => {
    const identity = await registeredActor();
    const campaign = await startCampaign(identity);
    const path = `/v1/actors/${identity.address}/campaigns/${campaign.campaignId}/next`;
    const issued = await (await SELF.fetch((await signedRequest(identity, path, undefined, undefined, "GET")).request)).json() as any;
    const sessionId = issued.sessionId;
    const subjectProof = { publicKey: identity.publicKey, signature: await identity.sign(["clankdar/subject/v1", sessionId, identity.publicKey]) };
    const submitPath = `/v1/actors/${identity.address}/sessions/${sessionId}`;
    const stub = env.ACTORS.getByName(identity.address);
    await runInDurableObject(stub, (instance) => {
      const internal = instance as any;
      internal.testOriginalEnv = internal.env;
      const evidence = internal.env.EVIDENCE;
      internal.env = { ...internal.env, EVIDENCE: { put: async (...args: unknown[]) => {
        if (failure === "after-write") await evidence.put(...args);
        throw new Error("test R2 unavailable");
      } } };
    });
    let frozen: any;
    try {
      const failed = await SELF.fetch((await signedRequest(identity, submitPath, { responses: {}, subjectProof })).request);
      expect(failed.status).toBe(503);
      const pending = await failed.json() as any;
      expect(pending.retryable).toBe(true);
      frozen = await runInDurableObject(stub, (_instance, state) => {
        const row = [...state.storage.sql.exec<any>("SELECT * FROM sessions WHERE id = ?", sessionId)][0]!;
        const outbox = [...state.storage.sql.exec<any>("SELECT * FROM evidence_outbox")][0]!;
        expect(row.sealed_ticket).toBeNull();
        expect(row.decided_at).toBeTruthy();
        expect(outbox.evidence_hash).toBe(row.evidence_hash);
        expect([...state.storage.sql.exec<any>("SELECT count(*) AS count FROM events WHERE type = 'epoch-decided'")][0].count).toBe(1);
        return outbox;
      });
    } finally {
      await runInDurableObject(stub, (instance) => {
        const internal = instance as any;
        internal.env = internal.testOriginalEnv;
        delete internal.testOriginalEnv;
      });
    }
    // Changed responses cannot reopen an already consumed session.
    const retry = await SELF.fetch((await signedRequest(identity, submitPath, { responses: { changed: "answer" }, subjectProof })).request);
    expect(retry.status).toBe(200);
    const recovered = await retry.json() as any;
    expect(recovered).toMatchObject({ evidenceHash: frozen.evidence_hash, verdict: false, passed: 0 });
    const published = await SELF.fetch(`https://example.test/v1/evidence/${recovered.evidenceHash}`);
    expect(await published.text()).toBe(frozen.evidence_text);
    await runInDurableObject(stub, (_instance, state) => {
      expect([...state.storage.sql.exec<any>("SELECT count(*) AS count FROM evidence_outbox")][0].count).toBe(0);
    });
  });

  test("a deep overdue backlog keeps the complete missed denominator while writes are bounded", async () => {
    const identity = await registeredActor();
    const campaign = await startCampaign(identity, 100);
    const stub = env.ACTORS.getByName(identity.address);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE campaigns SET starts_at = ? WHERE id = ?", new Date(Date.now() - 101 * 60_000).toISOString(), campaign.campaignId);
    });
    const profile = await (await SELF.fetch(`https://example.test/v1/actors/${identity.address}`)).json() as any;
    expect(profile.claims.automatedAvailability).toEqual({ completed: 0, missed: 100, rate: 0 });
    expect(profile.campaigns[0].evidence).toMatchObject({ scheduled: 100, missed: 100, pending: 0, materialized: 100, unmaterializedMisses: 0 });
    expect(profile.campaigns[0].scheduleSeed).toEqual(expect.any(String));
    const history = await (await SELF.fetch(`https://example.test/v1/actors/${identity.address}/events`)).json() as any;
    expect(history.events.map((event: any) => event.type)).toEqual(["registered", "campaign-started", "epochs-missed", "campaign-completed"]);
    expect(history.events[2].payload).toMatchObject({ firstEpoch: 0, lastEpoch: 99, count: 100 });
    const page = await (await SELF.fetch(`https://example.test/v1/actors/${identity.address}/campaigns/${campaign.campaignId}?limit=10`)).json() as any;
    expect(page.campaign.evidence).toMatchObject({ missed: 100, materialized: 100, unmaterializedMisses: 0 });
    expect(page.campaign.epochsPage.epochs).toHaveLength(10);
    expect(page.campaign.epochsPage.next).toBe(9);
    expect(page.campaign.epochsPage.epochs.every((epoch: any) => epoch.status === "missed")).toBe(true);
    const html = await SELF.fetch(`https://example.test/actors/${identity.address}/campaigns/${campaign.campaignId}`);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("0 responded · 100 missed");
  });

  test("staging lifetime capacity and chunked request bodies have hard bounds", async () => {
    const identity = await registeredActor();
    const path = `/v1/actors/${identity.address}/campaigns`;
    const over = await signedRequest(identity, path, { policyId: "v2-floor-v1", epochs: 1025, cadenceSeconds: 60, windowSeconds: 60 });
    expect((await SELF.fetch(over.request)).status).toBe(429);
    let sent = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { sent++; controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    });
    const result = await readBody(new Request("https://example.test/body", { method: "POST", body: stream }), 4096);
    expect(result).toBeNull();
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThanOrEqual(6);
    const stalled = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}); },
      cancel() { return new Promise<void>(() => {}); },
    });
    expect(await readBody(new Request("https://example.test/body", { method: "POST", body: stalled }), 4096, 5)).toBeNull();
    expect((await SELF.fetch("https://example.test/v1/actors?limit=0")).status).toBe(400);
  });

  test("fails closed on malformed registration, pages, unknown actors, and evidence", async () => {
    expect((await SELF.fetch("https://example.test/v1/actors", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await SELF.fetch("https://example.test/v1/actors?limit=1e2")).status).toBe(400);
    expect((await SELF.fetch(`https://example.test/v1/actors/clank1_${"x".repeat(27)}`)).status).toBe(404);
    expect((await SELF.fetch(`https://example.test/v1/evidence/${"0".repeat(64)}`)).status).toBe(404);
    const policies = await (await SELF.fetch("https://example.test/v1/policies")).json() as any;
    expect(policies.policies.map((policy: any) => policy.id).sort()).toEqual(["algal-floor-v1", "frontier-floor-v1", "v2-floor-v1"]);
    expect((await SELF.fetch("https://example.test/v1/policies/algal-floor-v1")).status).toBe(200);
    expect((await SELF.fetch("https://example.test/v1/policies/v2-floor-v1")).status).toBe(200);
    expect((await SELF.fetch("https://example.test/v1/policies/nope")).status).toBe(404);
    expect((await SELF.fetch("https://example.test/v1/policies/constructor")).status).toBe(404);
    const identity = await registeredActor();
    expect((await SELF.fetch((await signedRequest(identity, `/v1/actors/${identity.address}/campaigns`, { policyId: "constructor", epochs: 1, cadenceSeconds: 60, windowSeconds: 60 })).request)).status).toBe(400);
    expect((await SELF.fetch("https://example.test/nope")).status).toBe(404);
  });
});
