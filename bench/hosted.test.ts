import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateVerifier } from "./attest.ts";
import { checkAdmission, issueSession, type GatePolicy, type GateSession } from "./gate.ts";
import { generatePool } from "./holdout.ts";
import { serveHosted } from "./hosted.ts";
import type { GateStore } from "./store.ts";
import {
  checkLoggedAdmission, checkLog, isSignedHead, proveSession,
  type SessionProof, type TlogHead, type TransparencyLog,
} from "./tlog.ts";

const verifier = generateVerifier();
const policy: GatePolicy = { suite: "v2", cells: ["arithmetic:t0", "arithmetic:t1"], challenges: 2, minPass: 1, ttlSeconds: 300 };

const answersOf = (session: GateSession) =>
  Object.fromEntries(session.tickets.map((t) => [t.challenge.challengeId, t.expected]));

const host = (opts: Partial<Parameters<typeof serveHosted>[0]> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "clankdar-hosted-"));
  return { dir, ...serveHosted({ dir, policy, verifierJwk: verifier.privateJwk, port: 0, ...opts }) };
};

/** Open a session over HTTP, then decide it with the server-side tickets (test-only store access). */
const openAndDecide = async (url: string, store: GateStore) => {
  const made = await fetch(`${url}/sessions`, { method: "POST", body: "{}" });
  expect(made.status).toBe(201);
  const { sessionId, challenges } = await made.json();
  const entry = store.session(sessionId)!;
  const responses = answersOf(entry.session);
  const decided = await fetch(`${url}/sessions/${sessionId}/responses`, { method: "POST", body: JSON.stringify({ responses }) });
  expect(decided.status).toBe(200);
  const { admission, receipts } = await decided.json();
  return { sessionId, challenges, admission, receipts };
};

describe("hosted issuer surface", () => {
  test("full roundtrip: session → admission → tlog → head → proof → second session extends the chain", async () => {
    const hosted = host();
    try {
      expect(statSync(hosted.dir).mode & 0o777).toBe(0o700);

      // The whole gate surface is served unchanged.
      const meta = await (await fetch(`${hosted.url}/policy`)).json();
      expect(meta.policy.challenges).toBe(2);
      expect(meta.verifier.publicKey).toBe(verifier.publicKey);
      expect(await (await fetch(`${hosted.url}/healthz`)).json()).toEqual({ ok: true });

      // First session: issuance is logged, then the decision is logged.
      const made = await fetch(`${hosted.url}/sessions`, { method: "POST", body: "{}" });
      expect(made.status).toBe(201);
      const { sessionId, challenges } = await made.json();

      const open = (await (await fetch(`${hosted.url}/tlog`)).json()) as TransparencyLog;
      expect(checkLog(open)).toEqual({ ok: true, count: 1 });
      expect(open.entries[0]).toMatchObject({ index: 0, type: "session", sessionId });

      const entry = hosted.store.session(sessionId)!;
      const responses = answersOf(entry.session);
      const decided = await fetch(`${hosted.url}/sessions/${sessionId}/responses`, { method: "POST", body: JSON.stringify({ responses }) });
      expect(decided.status).toBe(200);
      const { admission, receipts } = await decided.json();
      expect(checkAdmission(admission)).toEqual({ ok: true, verdict: true, passed: 2 });
      expect(receipts).toHaveLength(2);
      expect((await fetch(`${hosted.url}/receipts/${challenges[0].challengeId}`)).status).toBe(200);

      // /tlog serves the current log: the session and its decision, digests only.
      const log = (await (await fetch(`${hosted.url}/tlog`)).json()) as TransparencyLog;
      expect(checkLog(log)).toEqual({ ok: true, count: 2 });
      expect(log.entries.map((e) => [e.index, e.type, e.sessionId])).toEqual([
        [0, "session", sessionId],
        [1, "decision", sessionId],
      ]);
      for (const e of log.entries) {
        expect(Object.keys(e).sort()).toEqual(["digest", "entryHash", "index", "prev", "sessionId", "type"]);
        expect(e.digest).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(log.entries[1].prev).toBe(log.entries[0].entryHash);
      expect(log.head.head).toBe(log.entries[1].entryHash);

      // A logged admission replays for checkLog consumers.
      expect(checkLoggedAdmission(log, admission)).toEqual({ ok: true, verdict: true, passed: 2 });

      // /tlog/head is the signed head a witness pins; it commits the same tip.
      const head = (await (await fetch(`${hosted.url}/tlog/head`)).json()) as TlogHead;
      expect(isSignedHead(head)).toBe(true);
      expect(head.count).toBe(2);
      expect(head.head).toBe(log.head.head);
      expect(head.verifier.keyId).toBe(verifier.keyId);

      // /tlog/proof returns the inclusion evidence a third party replays.
      const proof = (await (await fetch(`${hosted.url}/tlog/proof/${sessionId}`)).json()) as SessionProof;
      expect(proof.sessionId).toBe(sessionId);
      expect(proof.sessionIndex).toBe(0);
      expect(proof.decisionIndex).toBe(1);
      expect(isSignedHead(proof.head)).toBe(true);
      const replayed = proveSession(log, sessionId);
      expect([proof.sessionIndex, proof.decisionIndex]).toEqual([replayed.sessionIndex, replayed.decisionIndex]);
      expect(log.entries[proof.sessionIndex]).toMatchObject({ type: "session", sessionId });
      expect(log.entries[proof.decisionIndex!]).toMatchObject({ type: "decision", sessionId });

      // A second session extends the chain: head count advances, prev links intact.
      const second = await openAndDecide(hosted.url, hosted.store);
      const extended = (await (await fetch(`${hosted.url}/tlog`)).json()) as TransparencyLog;
      expect(checkLog(extended)).toEqual({ ok: true, count: 4 });
      expect(extended.entries.map((e) => e.type)).toEqual(["session", "decision", "session", "decision"]);
      expect(extended.entries[2].sessionId).toBe(second.sessionId);
      expect(extended.entries[2].prev).toBe(extended.entries[1].entryHash);
      expect(extended.entries[3].prev).toBe(extended.entries[2].entryHash);
      expect(extended.head.count).toBe(4);
      expect(extended.head.head).toBe(extended.entries[3].entryHash);
      const proof2 = (await (await fetch(`${hosted.url}/tlog/proof/${second.sessionId}`)).json()) as SessionProof;
      expect([proof2.sessionIndex, proof2.decisionIndex]).toEqual([2, 3]);
      expect((await fetch(`${hosted.url}/tlog/proof/gs_aaaaaaaaaaaa`)).status).toBe(404);
    } finally {
      hosted.close();
    }
  });

  test("edge statuses carry over from the gate; tlog routes are read-only", async () => {
    const hosted = host({ rateLimits: { openTotal: 1 } });
    try {
      // 400: malformed bodies.
      expect((await fetch(`${hosted.url}/sessions`, { method: "POST", body: "not json" })).status).toBe(400);
      const made = await fetch(`${hosted.url}/sessions`, { method: "POST", body: "{}" });
      const { sessionId } = await made.json();
      const submit = `${hosted.url}/sessions/${sessionId}/responses`;
      expect((await fetch(submit, { method: "POST", body: JSON.stringify({ responses: { bogus: "1" } }) })).status).toBe(400);
      // 404: unknown session and unknown receipt.
      expect((await fetch(`${hosted.url}/sessions/gs_aaaaaaaaaaaa/responses`, { method: "POST", body: "{}" })).status).toBe(404);
      expect((await fetch(`${hosted.url}/receipts/att_aaaaaaaaaaaa`)).status).toBe(404);
      // 429: the open-session cap is enforced through the same handler.
      expect((await fetch(`${hosted.url}/sessions`, { method: "POST", body: "{}" })).status).toBe(429);
      // 410: an expired session reports gone.
      const stale = issueSession({ policy, verifierJwk: verifier.privateJwk, now: new Date(Date.now() - 600_000), pick: () => 0 });
      hosted.store.issueSession(stale.session);
      expect((await fetch(`${hosted.url}/sessions/${stale.session.sessionId}/responses`, { method: "POST", body: JSON.stringify({ responses: {} }) })).status).toBe(410);
      // The tlog routes exist for GET only; anything else falls through to 404.
      expect((await fetch(`${hosted.url}/tlog`, { method: "POST", body: "{}" })).status).toBe(404);
      expect((await fetch(`${hosted.url}/tlog/proof/not-a-session`)).status).toBe(404);
      expect((await fetch(`${hosted.url}/tlog/elsewhere`)).status).toBe(404);
    } finally {
      hosted.close();
    }
  });

  test("the holdout pool passes through: h: policies mint marked challenges, and still get logged", async () => {
    const pool = generatePool({ suite: "frontier", cells: ["sat:t4"] });
    const hPolicy: GatePolicy = { suite: "frontier", cells: ["h:sat:t4"], challenges: 2, minPass: 1, ttlSeconds: 300 };
    const hosted = host({ policy: hPolicy, pool });
    try {
      const made = await fetch(`${hosted.url}/sessions`, { method: "POST", body: "{}" });
      expect(made.status).toBe(201);
      const { sessionId, challenges } = await made.json();
      expect(challenges.every((c: { heldout?: { poolKey: string } }) => c.heldout?.poolKey === pool.poolKey)).toBe(true);
      const log = (await (await fetch(`${hosted.url}/tlog`)).json()) as TransparencyLog;
      expect(checkLog(log)).toEqual({ ok: true, count: 1 });
      expect(log.entries[0].sessionId).toBe(sessionId);
    } finally {
      hosted.close();
    }

    // An h: policy without a pool still boots (checker-path syntax), but issuance refuses.
    const poolless = host({ policy: hPolicy });
    try {
      const made = await fetch(`${poolless.url}/sessions`, { method: "POST", body: "{}" });
      expect(made.status).toBe(400);
    } finally {
      poolless.close();
    }

    // A pool that does not cover the policy's h: cells refuses at serve time.
    const otherPool = generatePool({ suite: "frontier", cells: ["automata:t6"] });
    expect(() => host({ policy: hPolicy, pool: otherPool })).toThrow("invalid gate policy");
  });
});

describe("hosted CLI", () => {
  const hostedBin = (...args: string[]) =>
    Bun.spawn([Bun.which("bun")!, resolve(import.meta.dir, "hosted.ts"), ...args], {
      cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    });

  test("head prints the current signed head a witness would pin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-hosted-"));
    const hosted = host({ dir });
    try {
      await openAndDecide(hosted.url, hosted.store);
    } finally {
      hosted.close();
    }
    const keyFile = join(dir, "verifier.json");
    writeFileSync(keyFile, JSON.stringify(verifier.privateJwk));
    const proc = hostedBin("head", "--dir", dir, "--key", keyFile);
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(code).toBe(0);
    const head = JSON.parse(stdout) as TlogHead;
    expect(isSignedHead(head)).toBe(true);
    expect(head.count).toBe(2); // session + decision entries
    expect(head.verifier.keyId).toBe(verifier.keyId);
  }, 15_000);

  test("serve boots the composed surface over the CLI flags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-hosted-"));
    writeFileSync(join(dir, "verifier.json"), JSON.stringify(verifier.privateJwk));
    writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
    // The CLI bounds --port to 1..65535; grab a free one first.
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);
    const proc = hostedBin("serve", "--key", join(dir, "verifier.json"), "--policy", join(dir, "policy.json"), "--dir", join(dir, "state"), "--port", String(port));
    try {
      const reader = proc.stderr.getReader();
      let banner = "";
      while (!banner.includes("\n")) {
        const { done, value } = await reader.read();
        if (done) break;
        banner += new TextDecoder().decode(value, { stream: true });
      }
      reader.releaseLock();
      const url = /listening at (http:\/\/\S+)/.exec(banner)?.[1];
      expect(url).toBeTruthy();
      expect(await (await fetch(`${url}/healthz`)).json()).toEqual({ ok: true });
      const head = (await (await fetch(`${url}/tlog/head`)).json()) as TlogHead;
      expect(isSignedHead(head)).toBe(true);
      expect(head.count).toBe(0); // fresh state dir: the signed genesis head
      expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }, 15_000);

  test("keys issue/list/revoke manage the key file; serve --auth-keys enforces it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-hosted-"));
    writeFileSync(join(dir, "verifier.json"), JSON.stringify(verifier.privateJwk));
    writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
    const keysPath = join(dir, "state", "keys.jsonl");

    // issue prints the raw token once and reports the key's quota.
    const issued = hostedBin("keys", "issue", "--keys", keysPath, "--name", "agent-7", "--quota-mints", "5", "--quota-window", "1h", "--quota-open", "3");
    const [issueCode, issueOut] = await Promise.all([issued.exited, new Response(issued.stdout).text()]);
    expect(issueCode).toBe(0);
    const { keyId, token, quota } = JSON.parse(issueOut);
    expect(token).toMatch(/^clk_[A-Za-z0-9_-]{32}$/);
    expect(quota).toEqual({ openSessions: 3, mintsPerWindow: { max: 5, seconds: 3600 } });

    // list shows the key's metadata — never the token or its hash.
    const listed = hostedBin("keys", "list", "--keys", keysPath);
    const [listCode, listOut] = await Promise.all([listed.exited, new Response(listed.stdout).text()]);
    expect(listCode).toBe(0);
    const views = JSON.parse(listOut);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ keyId, name: "agent-7", revoked: false, mints: 0 });
    expect(listOut).not.toContain(token);

    // serve --auth-keys: 401 without a token, 201 with it, quota and ledger
    // mint records accumulate under the key.
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port;
    probe.stop(true);
    const proc = hostedBin("serve", "--key", join(dir, "verifier.json"), "--policy", join(dir, "policy.json"), "--dir", join(dir, "state"), "--auth-keys", keysPath, "--port", String(port));
    try {
      const reader = proc.stderr.getReader();
      let banner = "";
      while (!banner.includes("\n")) {
        const { done, value } = await reader.read();
        if (done) break;
        banner += new TextDecoder().decode(value, { stream: true });
      }
      reader.releaseLock();
      const url = /listening at (http:\/\/\S+)/.exec(banner)?.[1];
      expect(url).toBeTruthy();
      expect(banner).toContain("bearer auth");
      expect((await fetch(`${url}/sessions`, { method: "POST", body: "{}" })).status).toBe(401);
      expect((await fetch(`${url}/sessions`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${token}` } })).status).toBe(201);
    } finally {
      proc.kill();
      await proc.exited;
    }

    // revoke appends; list folds it in.
    const revoked = hostedBin("keys", "revoke", "--keys", keysPath, "--key-id", keyId);
    const [revokeCode] = await Promise.all([revoked.exited, new Response(revoked.stdout).text()]);
    expect(revokeCode).toBe(0);
    const listedAgain = hostedBin("keys", "list", "--keys", keysPath);
    const [, listOut2] = await Promise.all([listedAgain.exited, new Response(listedAgain.stdout).text()]);
    expect(JSON.parse(listOut2)[0]).toMatchObject({ keyId, revoked: true, mints: 1 });
  }, 30_000);

  test("keys issue rejects a dangling --quota-window or --quota-mints", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-hosted-"));
    const keysPath = join(dir, "keys.jsonl");
    for (const args of [
      ["keys", "issue", "--keys", keysPath, "--quota-window", "1h"],
      ["keys", "issue", "--keys", keysPath, "--quota-mints", "5"],
    ]) {
      const proc = hostedBin(...args);
      const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      expect(code).toBe(2);
      expect(stderr).toContain("requires --quota-");
    }
  }, 15_000);

  test("serve refuses a --pool that does not cover the policy's held-out cells", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-hosted-"));
    writeFileSync(join(dir, "verifier.json"), JSON.stringify(verifier.privateJwk));
    writeFileSync(join(dir, "policy.json"), JSON.stringify({ suite: "frontier", cells: ["h:sat:t4"], challenges: 2, minPass: 1, ttlSeconds: 300 }));
    writeFileSync(join(dir, "pool.json"), JSON.stringify(generatePool({ suite: "frontier", cells: ["automata:t6"] })));
    const proc = hostedBin("serve", "--key", join(dir, "verifier.json"), "--policy", join(dir, "policy.json"), "--pool", join(dir, "pool.json"), "--dir", join(dir, "state"), "--port", "0");
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).toBe(2);
    expect(stderr).toContain("invalid gate policy");
  }, 15_000);
});
