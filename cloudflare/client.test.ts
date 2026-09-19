import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endpoint, response, runSolver, type IssuedSession } from "./client.ts";
import { actorAddress, requestTranscript, verifyActorSignature } from "./src/protocol.ts";

const directory = mkdtempSync(join(tmpdir(), "clankdar-client-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const client = new URL("./client.ts", import.meta.url).pathname;
const campaignId = "cmp_abcdefghijklmnop";
const sessionId = "gs_abcdefghijkl";
let fileNumber = 0;
const file = (name: string) => join(directory, `${fileNumber++}-${name}`);
const script = (source: string) => {
  const path = file("solver");
  writeFileSync(path, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
};
const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
const key = await crypto.subtle.exportKey("jwk", pair.privateKey) as JsonWebKey;
const keyFile = file("actor.json");
writeFileSync(keyFile, JSON.stringify(key), { mode: 0o600 });
const address = await actorAddress(key.x!);
const issued = (): IssuedSession => ({ state: "issued", campaignId, epoch: 0, sessionId, expiresAt: new Date(Date.now() + 15_000).toISOString(), challenges: [{ challengeId: "challenge_1", prompt: "Return a response" }] });

async function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn([process.execPath, client, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe("hosted actor client", () => {
  test("help and campaign defaults make a bounded first run discoverable", async () => {
    const help = await cli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--max-seconds 90000");
    let body: unknown;
    const server = Bun.serve({ port: 0, async fetch(req) {
      body = await req.json();
      return Response.json({ ok: true, campaign: { campaignId } });
    } });
    try {
      const result = await cli(["campaign", "--url", server.url.origin, "--key", keyFile]);
      expect(result.code).toBe(0);
      expect(body).toEqual({ policyId: "v2-floor-v1", epochs: 24, cadenceSeconds: 3600, windowSeconds: 120 });
      expect(JSON.parse(result.stdout).profileUrl).toBe(`${server.url.origin}/actors/${address}`);
      expect(JSON.parse(result.stdout).nextSteps.join(" ")).toContain("25 hours");
    } finally { server.stop(true); }
  });

  test("rejects unsafe URLs, path IDs, and existing outputs before remote effects", async () => {
    for (const url of ["http://example.com", "https://user:pass@example.com", "https://example.com/prefix", "https://example.com?key=x", "https://example.com#fragment"]) expect(() => endpoint(url)).toThrow();
    expect(endpoint("https://example.com/")).toBe("https://example.com");
    expect(endpoint("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    let calls = 0;
    const server = Bun.serve({ port: 0, fetch() { calls++; return Response.json({ ok: true }); } });
    try {
      const bad = await cli(["next", "--url", server.url.origin, "--key", keyFile, "--campaign", "../../issuer"]);
      expect(bad.code).toBe(2);
      const output = file("existing.json");
      writeFileSync(output, "keep me");
      const result = await cli(["campaign", "--url", server.url.origin, "--key", keyFile, "--out", output]);
      expect(result.code).toBe(2);
      expect(readFileSync(output, "utf8")).toBe("keep me");
      expect(calls).toBe(0);
    } finally { server.stop(true); }
    const output = file("generated.json");
    expect((await cli(["keygen", "--out", output])).code).toBe(0);
    expect(statSync(output).mode & 0o777).toBe(0o600);
  });

  test("one issued epoch runs once, strips ambient secrets, and retries publication with a fresh signed nonce", async () => {
    const marker = file("invocations");
    const solver = script(`import { appendFileSync } from 'node:fs';
const session = JSON.parse(await Bun.stdin.text());
if (process.env.CLANKDAR_ACTOR_KEY || process.env.REGISTRATION_TOKEN || process.env.UNREQUESTED_PROVIDER_SECRET) process.exit(3);
if (process.env.EXPLICIT_PROVIDER_CREDENTIAL !== 'allow-this') process.exit(4);
if ('d' in session || 'subjectProof' in session || 'privateKey' in session) process.exit(5);
appendFileSync(${JSON.stringify(marker)}, '1');
console.log(JSON.stringify({[session.challenges[0].challengeId]: 'answer'}));`);
    const seen: Array<{ nonce: string; body: unknown; valid: boolean }> = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET") return Response.json(issued());
      const bytes = new Uint8Array(await req.arrayBuffer());
      const nonce = req.headers.get("x-clankdar-nonce")!;
      const transcript = await requestTranscript(address, key.x!, req.headers.get("x-clankdar-timestamp")!, nonce, "POST", path, bytes);
      const body = JSON.parse(new TextDecoder().decode(bytes));
      const valid = await verifyActorSignature(key.x!, transcript, req.headers.get("x-clankdar-signature")!);
      seen.push({ nonce, body, valid });
      if (seen.length === 1) return Response.json({ reason: "publication unavailable" }, { status: 503 });
      return Response.json({ ok: true, evidenceHash: "a".repeat(64), verdict: true, passed: 1 }, { status: 201 });
    } });
    try {
      const result = await cli(["run", "--url", server.url.origin, "--key", keyFile, "--campaign", campaignId, "--solver", solver, "--once", "--pass-env", "EXPLICIT_PROVIDER_CREDENTIAL"], { CLANKDAR_ACTOR_KEY: "must-not-leak", REGISTRATION_TOKEN: "must-not-leak", UNREQUESTED_PROVIDER_SECRET: "must-not-leak", EXPLICIT_PROVIDER_CREDENTIAL: "allow-this" });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ submitted: 1, state: "once" });
      expect(readFileSync(marker, "utf8")).toBe("1");
      expect(seen).toHaveLength(2);
      expect(seen.every((call) => call.valid)).toBe(true);
      expect(seen[0]!.nonce).not.toBe(seen[1]!.nonce);
      expect(seen[0]!.body).toEqual(seen[1]!.body);
      const proof = (seen[0]!.body as { subjectProof: { signature: string } }).subjectProof;
      expect(await verifyActorSignature(key.x!, ["clankdar/subject/v1", sessionId, key.x], proof.signature)).toBe(true);
      expect(result.stdout + result.stderr).not.toContain("must-not-leak");
    } finally { server.stop(true); }
  });

  test("waiting once does not invoke a solver, and polling has a wall-clock bound", async () => {
    const marker = file("should-not-run");
    const solver = script(`await Bun.write(${JSON.stringify(marker)}, 'bad'); console.log('{}');`);
    let polls = 0;
    const server = Bun.serve({ port: 0, fetch() { polls++; return Response.json({ ok: true, state: "waiting", next: { opensAt: new Date(Date.now() + 60_000).toISOString() } }); } });
    try {
      const args = ["run", "--url", server.url.origin, "--key", keyFile, "--campaign", campaignId, "--solver", solver];
      const once = await cli([...args, "--once"]);
      expect(once.code).toBe(0);
      expect(JSON.parse(once.stdout).state).toBe("waiting");
      expect(polls).toBe(1);
      const start = Date.now();
      const bounded = await cli([...args, "--max-seconds", "1"]);
      expect(bounded.code).toBe(0);
      expect(JSON.parse(bounded.stdout).state).toBe("time-limit");
      expect(Date.now() - start).toBeLessThan(3000);
      expect(existsSync(marker)).toBe(false);
    } finally { server.stop(true); }
  });

  test("solver deadline, abort, and output limits terminate the executable", async () => {
    const noisy = script("process.stdout.write('x'.repeat(1_048_577)); setInterval(() => {}, 1000);");
    await expect(runSolver(noisy, issued(), new AbortController().signal, 3000)).rejects.toThrow("output is too large");
    const forever = script("setInterval(() => {}, 1000);");
    const start = Date.now();
    await expect(runSolver(forever, issued(), new AbortController().signal, 100)).rejects.toThrow("deadline or run limit");
    expect(Date.now() - start).toBeLessThan(1000);
    const controller = new AbortController();
    const pending = runSolver(forever, issued(), controller.signal, 5000);
    controller.abort();
    await expect(pending).rejects.toThrow("interrupted");
    const malformed = script("console.log(JSON.stringify({another_challenge: 'not in session'}));");
    await expect(runSolver(malformed, issued(), new AbortController().signal, 1000)).rejects.toThrow("this session's challenge IDs");
  });

  test("Ctrl-C stops a running solver and returns an explicit interruption result", async () => {
    const pidFile = file("solver.pid");
    const solver = script(`await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const server = Bun.serve({ port: 0, fetch() { return Response.json(issued()); } });
    const proc = Bun.spawn([process.execPath, client, "run", "--url", server.url.origin, "--key", keyFile, "--campaign", campaignId, "--solver", solver], { stdout: "pipe", stderr: "pipe" });
    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(pidFile)).toBe(true);
      const solverPid = Number(readFileSync(pidFile, "utf8"));
      proc.kill("SIGINT");
      const [stdout, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(130);
      expect(JSON.parse(stdout).state).toBe("interrupted");
      const stoppedBy = Date.now() + 1000;
      let stopped = false;
      while (Date.now() < stoppedBy) {
        try { process.kill(solverPid, 0); } catch { stopped = true; break; }
        await Bun.sleep(10);
      }
      expect(stopped).toBe(true);
    } finally { proc.kill(); server.stop(true); }
  });

  test("HTTP bodies are stream-bounded and rejected bodies never expose secrets", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(131_072)); }, cancel() { canceled = true; } });
    await expect(response(new Response(stream))).rejects.toThrow("too large");
    expect(canceled).toBe(true);
    await expect(response(Response.json({ reason: "sensitive-reflected-token" }, { status: 401 }))).rejects.toThrow("hosted request failed (401)");
  });
});
