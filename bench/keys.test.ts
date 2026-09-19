import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateVerifier } from "./attest.ts";
import { sha256 } from "./canon.ts";
import type { GatePolicy, GateSession } from "./gate.ts";
import { serveHosted } from "./hosted.ts";
import { KeyStore, type KeyQuota } from "./keys.ts";

const verifier = generateVerifier();
const policy: GatePolicy = { suite: "v2", cells: ["arithmetic:t0", "arithmetic:t1"], challenges: 2, minPass: 1, ttlSeconds: 300 };

const answersOf = (session: GateSession) =>
  Object.fromEntries(session.tickets.map((t) => [t.challenge.challengeId, t.expected]));

const setup = (opts: Partial<Parameters<typeof serveHosted>[0]> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "clankdar-keys-"));
  const keys = KeyStore.open(join(dir, "gate-keys.jsonl"));
  const hosted = serveHosted({ dir, policy, verifierJwk: verifier.privateJwk, keys, port: 0, ...opts });
  return { dir, keys, ...hosted };
};

const mint = (url: string, token?: string) =>
  fetch(`${url}/sessions`, {
    method: "POST", body: "{}",
    headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
  });

describe("client key store", () => {
  test("issue stores only the token hash; replay restores the same state", () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-keys-"));
    const path = join(dir, "gate-keys.jsonl");
    const keys = KeyStore.open(path);
    const { keyId, token } = keys.issue({ name: "agent-7", quota: { openSessions: 2 } });
    expect(token).toMatch(/^clk_[A-Za-z0-9_-]{32}$/);
    expect(keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(keyId).toBe(sha256(token).slice(0, 16));
    expect(keys.authenticate(token)).toBe(keyId);
    expect(keys.authenticate(`clk_${"x".repeat(32)}`)).toBeNull(); // unknown token
    expect(keys.authenticate("not-a-token")).toBeNull(); // malformed
    expect(keys.authenticate("")).toBeNull();

    // The file holds the hash — never the raw token.
    const file = readFileSync(path, "utf8");
    expect(file).not.toContain(token);
    expect(file).toContain(sha256(token));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    keys.close();

    const reopened = KeyStore.open(path);
    expect(reopened.authenticate(token)).toBe(keyId);
    expect(reopened.list()).toEqual([
      { keyId, name: "agent-7", quota: { openSessions: 2 }, createdAt: expect.any(String), revoked: false, mints: 0 },
    ]);
    reopened.close();
  });

  test("revocation is an appended record; unknown and double revocations refuse", () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-keys-"));
    const path = join(dir, "gate-keys.jsonl");
    const keys = KeyStore.open(path);
    const { keyId, token } = keys.issue();
    keys.revoke(keyId);
    expect(keys.authenticate(token)).toBeNull();
    expect(() => keys.revoke(keyId)).toThrow("already revoked");
    expect(() => keys.revoke("0".repeat(16))).toThrow("unknown keyId");
    const [view] = keys.list();
    expect(view.revoked).toBe(true);
    expect(view.revokedAt).toEqual(expect.any(String));
    keys.close();

    // Revocation survives replay — it is the fold, not a flag.
    const reopened = KeyStore.open(path);
    expect(reopened.authenticate(token)).toBeNull();
    expect(reopened.list()[0].revoked).toBe(true);
    reopened.close();
  });

  test("replay drops a torn tail but refuses mid-file corruption", () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-keys-"));
    const path = join(dir, "gate-keys.jsonl");
    const keys = KeyStore.open(path);
    const { keyId, token } = keys.issue();
    keys.close();
    appendFileSync(path, `{"type":"key","keyId":"deadbeef`);
    const reopened = KeyStore.open(path); // torn tail is dropped, not fatal
    expect(reopened.authenticate(token)).toBe(keyId);
    reopened.close();

    const corrupt = join(dir, "corrupt.jsonl");
    const valid = JSON.stringify({ type: "key", keyId: "0".repeat(16), secretHash: "0".repeat(64), quota: {}, createdAt: new Date().toISOString() });
    writeFileSync(corrupt, `${valid}\nnot json\n${valid}\n`);
    expect(() => KeyStore.open(corrupt)).toThrow("corrupt at record 2");
    const badRevoke = join(dir, "bad-revoke.jsonl");
    writeFileSync(badRevoke, `${JSON.stringify({ type: "revoke", keyId: "1".repeat(16), revokedAt: new Date().toISOString() })}\n`);
    expect(() => KeyStore.open(badRevoke)).toThrow("revocation for an unknown key");
  });

  test("quota checks fold mint records against the ledger's live set", () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-keys-"));
    const keys = KeyStore.open(join(dir, "gate-keys.jsonl"));
    const quota: KeyQuota = { openSessions: 1, mintsPerWindow: { max: 2, seconds: 60 } };
    const { keyId } = keys.issue({ quota });
    const t0 = Date.parse("2026-09-19T00:00:00Z");
    let open: { sessionId: string }[] = [];
    const ledger = { openSessions: () => open };

    expect(keys.withinQuota(keyId, ledger, t0)).toBe(true);
    keys.recordMint(keyId, "gs_aaaaaaaaaaaa", new Date(t0));
    open = [{ sessionId: "gs_aaaaaaaaaaaa" }];
    // The open-session cap binds while the minted session is still live.
    expect(keys.withinQuota(keyId, ledger, t0)).toBe(false);
    // Once it decides or expires out of the live set, the open cap frees —
    // the mint still counts against the rolling window.
    open = [];
    expect(keys.withinQuota(keyId, ledger, t0)).toBe(true);
    keys.recordMint(keyId, "gs_bbbbbbbbbbbb", new Date(t0 + 1_000));
    expect(keys.withinQuota(keyId, ledger, t0 + 2_000)).toBe(false);
    // Both mints age out of the window together.
    expect(keys.withinQuota(keyId, ledger, t0 + 61_000)).toBe(true);
    // An unconfigured key has no quota.
    const plain = keys.issue();
    expect(keys.withinQuota(plain.keyId, ledger, t0)).toBe(true);
    keys.close();
  });
});

describe("hosted write-path auth", () => {
  test("POST /sessions requires a bearer token when keys are configured; all rejections are one static 401", async () => {
    const hosted = setup();
    try {
      const { token } = hosted.keys.issue({ name: "agent-7" });
      const rejections: Record<string, string>[] = [
        {}, // no header
        { authorization: `Bearer ${"x".repeat(40)}` }, // unknown token
        { authorization: "Bearer not-a-token" }, // malformed token
        { authorization: "Digest ignored" }, // wrong scheme
        { authorization: "Bearer" }, // no token
      ];
      for (const headers of rejections) {
        const res = await fetch(`${hosted.url}/sessions`, { method: "POST", body: "{}", headers });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ ok: false, reason: "unauthorized" });
        expect(res.headers.get("www-authenticate")).toBe("Bearer");
      }
      expect((await mint(hosted.url, token)).status).toBe(201);
      // Submit stays unauthenticated — the live session id is the capability.
      const { sessionId } = await (await mint(hosted.url, token)).json();
      const entry = hosted.store.session(sessionId)!;
      const submit = await fetch(`${hosted.url}/sessions/${sessionId}/responses`, {
        method: "POST", body: JSON.stringify({ responses: answersOf(entry.session) }),
      });
      expect(submit.status).toBe(200);
      // Reads stay open: no token needed for the published evidence.
      expect((await fetch(`${hosted.url}/policy`)).status).toBe(200);
      expect((await fetch(`${hosted.url}/tlog/head`)).status).toBe(200);
    } finally {
      hosted.close();
      hosted.keys.close();
    }
  });

  test("revoked keys 401 exactly like unknown ones; mints-per-window exhausts to a static 429", async () => {
    const hosted = setup();
    try {
      const first = hosted.keys.issue({ quota: { mintsPerWindow: { max: 1, seconds: 60 } } });
      expect((await mint(hosted.url, first.token)).status).toBe(201);
      const blocked = await mint(hosted.url, first.token);
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toEqual({ ok: false, reason: "quota" });

      const second = hosted.keys.issue();
      expect((await mint(hosted.url, second.token)).status).toBe(201);
      hosted.keys.revoke(second.keyId);
      const revoked = await mint(hosted.url, second.token);
      expect(revoked.status).toBe(401);
      expect(await revoked.json()).toEqual({ ok: false, reason: "unauthorized" });
    } finally {
      hosted.close();
      hosted.keys.close();
    }
  });

  test("open-session quota frees on decision; keyIds never reach the ledger or the tlog", async () => {
    const hosted = setup();
    try {
      const { keyId, token } = hosted.keys.issue({ quota: { openSessions: 1 } });
      const made = await mint(hosted.url, token);
      expect(made.status).toBe(201);
      const { sessionId } = await made.json();
      expect((await mint(hosted.url, token)).status).toBe(429); // one live session held
      const entry = hosted.store.session(sessionId)!;
      const decided = await fetch(`${hosted.url}/sessions/${sessionId}/responses`, {
        method: "POST", body: JSON.stringify({ responses: answersOf(entry.session) }),
      });
      expect(decided.status).toBe(200);
      expect((await mint(hosted.url, token)).status).toBe(201); // decided sessions free the slot

      // The key file carries the mint record; the ledger and the published
      // log never see the keyId.
      expect(readFileSync(join(hosted.dir, "gate-keys.jsonl"), "utf8")).toContain(`"keyId":"${keyId}"`);
      const ledger = readFileSync(join(hosted.dir, "gate-state.jsonl"), "utf8");
      expect(ledger).not.toContain(keyId);
      const tlog = await (await fetch(`${hosted.url}/tlog`)).text();
      expect(tlog).not.toContain(keyId);
      expect(hosted.keys.list()[0].mints).toBe(2);
    } finally {
      hosted.close();
      hosted.keys.close();
    }
  });

  test("per-key quotas compose the gate's own rate limits", async () => {
    const hosted = setup({ rateLimits: { openTotal: 2 } });
    try {
      const a = hosted.keys.issue({ quota: { openSessions: 1 } });
      const b = hosted.keys.issue();
      expect((await mint(hosted.url, a.token)).status).toBe(201);
      // Key A's own quota binds before the global cap does.
      const quota429 = await mint(hosted.url, a.token);
      expect(quota429.status).toBe(429);
      expect(await quota429.json()).toEqual({ ok: false, reason: "quota" });
      // Key B has no key quota, so the global gate limit answers instead.
      expect((await mint(hosted.url, b.token)).status).toBe(201);
      const global429 = await mint(hosted.url, b.token);
      expect(global429.status).toBe(429);
      expect(await global429.json()).toEqual({ error: "gate at capacity; retry when open sessions drain" });
    } finally {
      hosted.close();
      hosted.keys.close();
    }
  });

  test("the mints-per-window quota rolls", async () => {
    const hosted = setup();
    try {
      const { token } = hosted.keys.issue({ quota: { mintsPerWindow: { max: 1, seconds: 2 } } });
      expect((await mint(hosted.url, token)).status).toBe(201);
      expect((await mint(hosted.url, token)).status).toBe(429);
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      expect((await mint(hosted.url, token)).status).toBe(201);
    } finally {
      hosted.close();
      hosted.keys.close();
    }
  }, 10_000);

  test("without keys the surface is unchanged: open mints, no 401s", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-keys-"));
    const hosted = serveHosted({ dir, policy, verifierJwk: verifier.privateJwk, port: 0 });
    try {
      expect((await mint(hosted.url)).status).toBe(201);
      expect((await mint(hosted.url)).status).toBe(201);
    } finally {
      hosted.close();
    }
  });
});
