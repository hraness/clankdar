import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { actorAddress, b64url, canonical, registrationTranscript, requestTranscript, unb64url } from "../src/protocol.ts";

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

async function signedRequest(identity: Awaited<ReturnType<typeof actor>>, path: string, body: unknown, reuse?: { timestamp: string; nonce: string; signature: string }) {
  const bytes = encoder.encode(JSON.stringify(body));
  const timestamp = reuse?.timestamp ?? new Date().toISOString();
  const nonce = reuse?.nonce ?? b64url(crypto.getRandomValues(new Uint8Array(18)));
  const signature = reuse?.signature ?? await identity.sign(await requestTranscript(identity.address, identity.publicKey, timestamp, nonce, "POST", path, bytes));
  const headers = { "content-type": "application/json", "x-clankdar-timestamp": timestamp, "x-clankdar-nonce": nonce, "x-clankdar-signature": signature };
  return { request: new Request(`https://example.test${path}`, { method: "POST", headers, body: bytes }), auth: { timestamp, nonce, signature } };
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
    expect(profile).toMatchObject({ protocol: "clankdar-actor-v1", address: identity.address, evidence: { events: 1, heartbeats: 0 }, claims: { keyContinuity: true, autonomous: null, capability: null, unique: false } });

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

  test("fails closed on malformed registration, pages, unknown actors, and evidence", async () => {
    expect((await SELF.fetch("https://example.test/v1/actors", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await SELF.fetch("https://example.test/v1/actors?limit=1e2")).status).toBe(400);
    expect((await SELF.fetch(`https://example.test/v1/actors/clank1_${"x".repeat(27)}`)).status).toBe(404);
    expect((await SELF.fetch(`https://example.test/v1/evidence/${"0".repeat(64)}`)).status).toBe(404);
    expect((await SELF.fetch("https://example.test/nope")).status).toBe(404);
  });
});
