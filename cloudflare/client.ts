#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { accessSync, closeSync, constants, lstatSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ACTOR_ADDRESS, actorAddress, b64url, canonical, registrationTranscript, requestTranscript } from "./src/protocol.ts";

const encoder = new TextEncoder();
const MAX_BYTES = 1_048_576;
const HTTP_TIMEOUT_MS = 15_000;
const USAGE = `usage: bun actor <command>
  keygen --out actor.json
  register --url URL --key actor.json --token-file FILE [--out result.json]
  campaign --url URL --key actor.json [--policy v2-floor-v1] [--epochs 24]
    [--cadence 3600] [--window 120] [--delay SEC] [--out result.json]
  run --url URL --key actor.json --campaign ID --solver EXECUTABLE
    [--once] [--max-seconds 90000] [--max-epochs 24] [--pass-env NAME[,NAME]] [--out result.json]
  next --url URL --key actor.json --campaign ID [--out result.json]
  submit --url URL --key actor.json --session ID --responses responses.json [--out result.json]
  profile --url URL --address clank1_… [--out result.json]

run calls only your explicit executable: JSON session on stdin, a JSON object
mapping challenge IDs to response strings on stdout. No model is selected or
called by default. Your solver may spend compute/inference budget. --once polls
once; a waiting window exits without calling the solver. Longer runs stop at
the first time/epoch limit. Actor keys and registration tokens are never passed
to the solver; by default it receives only PATH, TMPDIR, LANG and LC_ALL.
Provider credentials require explicit --pass-env NAME (for example ANTHROPIC_API_KEY).`;

type ActorJwk = JsonWebKey & { kty: "OKP"; crv: "Ed25519"; x: string; d: string };
type JsonObject = Record<string, unknown>;
export interface IssuedSession {
  state: "issued";
  campaignId: string;
  epoch: number;
  sessionId: string;
  expiresAt: string;
  challenges: Array<{ challengeId: string; [key: string]: unknown }>;
}

function object(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
const loadJson = (path: string): unknown => {
  if (!statSync(path).isFile() || statSync(path).size > MAX_BYTES) throw new Error("input must be a file no larger than 1 MiB");
  return JSON.parse(readFileSync(path, "utf8"));
};
const loadKey = (path: string): ActorJwk => {
  const key = loadJson(path) as ActorJwk;
  if (key?.kty !== "OKP" || key.crv !== "Ed25519" || !/^[A-Za-z0-9_-]{43}$/.test(key.x ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(key.d ?? "")) throw new Error("actor key must be an Ed25519 private JWK");
  return key;
};
const integer = (value: string, name: string, min: number, max: number) => {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${name} must be ${min}..${max}`);
  return number;
};
export const endpoint = (value: string | undefined): string => {
  if (!value) throw new Error("--url is required");
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("URL must use HTTPS or loopback HTTP");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("URL must be an origin without a path, credentials, query, or fragment");
  return url.origin;
};
function identifier(value: string | undefined, name: "campaign" | "session"): string {
  if (!value || !(name === "campaign" ? /^cmp_[A-Za-z0-9_-]{16}$/ : /^gs_[A-Za-z0-9_-]{12}$/).test(value)) throw new Error(`--${name} is malformed`);
  return value;
}
function preflightOutput(path?: string): void {
  if (!path) return;
  try { lstatSync(path); throw new Error("output file already exists"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!statSync(dirname(resolve(path))).isDirectory()) throw new Error("output parent must be a directory");
  accessSync(dirname(resolve(path)), constants.W_OK);
}
// Display copyable commands without turning paths into shell substitutions.
const commandLine = (args: string[]): string => args.map((arg) => /^[A-Za-z0-9_./:=+-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'").join(" ");
const sign = async (key: ActorJwk, transcript: unknown) => {
  const privateKey = await crypto.subtle.importKey("jwk", key, { name: "Ed25519" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("Ed25519", privateKey, encoder.encode(canonical(transcript))));
};
const emit = (value: unknown, out?: string) => {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (out) {
    const fd = openSync(out, "wx", 0o600);
    try { writeFileSync(fd, text); } finally { closeSync(fd); }
  } else process.stdout.write(text);
};

export class HostedError extends Error {
  constructor(readonly status: number) {
    const guidance: Record<number, string> = { 401: "check the invite token or actor key/signature", 429: "staging capacity or request limit reached; try later", 503: "service or evidence publication is temporarily unavailable" };
    super(`hosted request failed (${status})${guidance[status] ? `: ${guidance[status]}` : ""}`);
  }
}

export async function response(res: Response): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("hosted response is empty");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); throw new Error("hosted response is too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  // Do not echo arbitrary server error bodies: they can contain reflected secrets.
  if (!res.ok) throw new HostedError(res.status);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("hosted response is not JSON"); }
}

async function request(url: string, init: RequestInit, signal?: AbortSignal, timeoutMs = HTTP_TIMEOUT_MS): Promise<unknown> {
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, HTTP_TIMEOUT_MS)));
  return response(await fetch(url, { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout }));
}

async function signedFetch(base: string, key: ActorJwk, path: string, method: "GET" | "POST", body?: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
  const address = await actorAddress(key.x);
  const bytes = method === "GET" ? new Uint8Array() : encoder.encode(JSON.stringify(body ?? {}));
  if (bytes.byteLength > 131_072) throw new Error("request body is too large");
  const timestamp = new Date().toISOString();
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const signature = await sign(key, await requestTranscript(address, key.x, timestamp, nonce, method, path, bytes));
  return request(`${base}${path}`, {
    method, headers: { "content-type": "application/json", "x-clankdar-timestamp": timestamp, "x-clankdar-nonce": nonce, "x-clankdar-signature": signature },
    body: method === "POST" ? bytes : undefined,
  }, signal, timeoutMs);
}

function validateResponses(value: unknown, session?: IssuedSession): Record<string, string> {
  if (!object(value) || Object.entries(value).some(([id, answer]) => !/^[A-Za-z0-9_-]{1,128}$/.test(id) || typeof answer !== "string" || encoder.encode(answer).length > 65_536)) throw new Error("responses must map challenge IDs to strings");
  if (session && Object.keys(value).some((id) => !session.challenges.some((challenge) => challenge.challengeId === id))) throw new Error("solver returned an unknown challenge ID");
  return value as Record<string, string>;
}

function solverPath(value?: string): string {
  if (!value) throw new Error("run requires --solver pointing to an executable file");
  const path = resolve(value);
  if (!statSync(path).isFile()) throw new Error("solver must be an executable file");
  accessSync(path, constants.X_OK);
  return path;
}

/** An explicit local program, never a shell command or a bundled model adapter. */
export async function runSolver(path: string, session: IssuedSession, signal: AbortSignal, budgetMs: number, passEnv: string[] = []): Promise<Record<string, string>> {
  const remaining = Math.min(Date.parse(session.expiresAt) - Date.now() - 500, budgetMs);
  if (!Number.isFinite(remaining) || remaining < 1) throw new Error("session deadline has passed");
  signal.throwIfAborted();
  const env: Record<string, string | undefined> = {};
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", ...passEnv]) if (process.env[name]) env[name] = process.env[name];
  return new Promise((resolveResult, reject) => {
    const child = spawn(path, [], { shell: false, detached: process.platform !== "win32", env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const kill = () => {
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Child may already have exited. */ }
    };
    const finish = (error?: Error, value?: Record<string, string>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      kill();
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (error) reject(error); else resolveResult(value!);
    };
    const abort = () => finish(new Error("actor run interrupted"));
    const timer = setTimeout(() => finish(new Error("solver exceeded the session deadline or run limit")), remaining);
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", () => finish(new Error("could not start solver executable")));
    child.stdin.on("error", () => finish(new Error("solver stopped reading its session")));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) finish(new Error("solver output is too large")); else chunks.push(chunk);
    });
    // Discard stderr rather than logging credentials or provider error bodies.
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) finish(new Error("solver output is too large"));
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) { finish(new Error("solver exited unsuccessfully")); return; }
      try { finish(undefined, validateResponses(JSON.parse(Buffer.concat(chunks).toString("utf8")), session)); }
      catch { finish(new Error("solver must return a JSON object mapping this session's challenge IDs to response strings")); }
    });
    child.stdin.end(JSON.stringify(session));
    if (signal.aborted) abort();
  });
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolvePause, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error("actor run interrupted")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolvePause(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function submit(base: string, key: ActorJwk, sessionId: string, responses: Record<string, string>, signal?: AbortSignal, until = Date.now() + HTTP_TIMEOUT_MS): Promise<unknown> {
  const address = await actorAddress(key.x);
  const subjectProof = { publicKey: key.x, signature: await sign(key, ["clankdar/subject/v1", sessionId, key.x]) };
  for (let attempt = 0; ; attempt++) {
    if (Date.now() >= until) throw new Error("submission time limit reached");
    try { return await signedFetch(base, key, `/v1/actors/${address}/sessions/${sessionId}`, "POST", { responses, subjectProof }, signal, until - Date.now()); }
    catch (error) {
      if (!(error instanceof HostedError) || error.status !== 503 || attempt >= 2 || until - Date.now() < 1_500) throw error;
      await pause(500, signal ?? new AbortController().signal);
    }
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  if (command === "--help" || command === "-h" || command === "help") { console.log(USAGE); return; }
  const { values } = parseArgs({ args: rest, options: {
    url: { type: "string" }, key: { type: "string" }, out: { type: "string" }, "token-file": { type: "string" },
    policy: { type: "string" }, epochs: { type: "string" }, cadence: { type: "string" }, window: { type: "string" }, delay: { type: "string" },
    campaign: { type: "string" }, session: { type: "string" }, responses: { type: "string" }, address: { type: "string" }, help: { type: "boolean", short: "h" },
    solver: { type: "string" }, "pass-env": { type: "string" }, once: { type: "boolean" }, "max-seconds": { type: "string" }, "max-epochs": { type: "string" },
  }, strict: true, allowPositionals: false });
  if (values.help || !command) { console.log(USAGE); return; }
  if (!["keygen", "register", "campaign", "next", "submit", "profile", "run"].includes(command)) throw new Error(`unknown command: ${command}\n${USAGE}`);
  preflightOutput(values.out);
  if (command === "keygen") {
    if (!values.out) throw new Error("keygen requires --out");
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const key = await crypto.subtle.exportKey("jwk", pair.privateKey) as ActorJwk;
    emit(key, values.out);
    console.log(JSON.stringify({ address: await actorAddress(key.x), publicKey: key.x, privateKeyFile: values.out }));
    return;
  }
  const base = endpoint(values.url);
  if (command === "profile") {
    if (!values.address || !ACTOR_ADDRESS.test(values.address)) throw new Error("profile requires a valid --address");
    emit(await request(`${base}/v1/actors/${values.address}`, {}), values.out);
    return;
  }
  if (!values.key) throw new Error(`${command} requires --key`);
  const key = loadKey(values.key);
  const address = await actorAddress(key.x);
  const profileUrl = `${base}/actors/${address}`;
  if (command === "register") {
    if (!values["token-file"]) throw new Error("register requires --token-file");
    if (!statSync(values["token-file"]).isFile() || statSync(values["token-file"]).size > 4096) throw new Error("registration token file is too large or not a regular file");
    const timestamp = new Date().toISOString();
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
    const body = { publicKey: key.x, timestamp, nonce, signature: await sign(key, registrationTranscript(key.x, timestamp, nonce)) };
    const token = readFileSync(values["token-file"], "utf8").trim();
    if (!token || /\s/.test(token)) throw new Error("registration token file must contain one token");
    const result = await request(`${base}/v1/actors`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    emit({ ...(object(result) ? result : { result }), profileUrl, nextSteps: [commandLine(["bun", "actor", "campaign", "--url", base, "--key", values.key]), "Save your actor key securely; it controls this address."] }, values.out);
    return;
  }
  if (command === "campaign") {
    const policyId = values.policy ?? "v2-floor-v1";
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(policyId)) throw new Error("--policy is malformed");
    const cadenceSeconds = integer(values.cadence ?? "3600", "--cadence", 60, 86_400);
    const body = { policyId, epochs: integer(values.epochs ?? "24", "--epochs", 1, 10_000), cadenceSeconds, windowSeconds: integer(values.window ?? "120", "--window", 30, cadenceSeconds), ...(values.delay ? { startDelaySeconds: integer(values.delay, "--delay", 0, 86_400) } : {}) };
    const result = await signedFetch(base, key, `/v1/actors/${address}/campaigns`, "POST", body);
    const createdId = object(result) && object(result.campaign) && typeof result.campaign.campaignId === "string" ? result.campaign.campaignId : "CAMPAIGN_ID";
    emit({ ...(object(result) ? result : { result }), profileUrl, nextSteps: [commandLine(["bun", "actor", "run", "--url", base, "--key", values.key, "--campaign", createdId, "--solver", "./solver"]), "The default run stops after 25 hours or 24 submitted epochs. Your solver pays any inference cost; use --once for one poll."] }, values.out);
    return;
  }
  if (command === "next") {
    const campaign = identifier(values.campaign, "campaign");
    emit(await signedFetch(base, key, `/v1/actors/${address}/campaigns/${campaign}/next`, "GET"), values.out);
    return;
  }
  if (command === "submit") {
    const session = identifier(values.session, "session");
    if (!values.responses) throw new Error("submit requires --responses");
    emit(await submit(base, key, session, validateResponses(loadJson(values.responses))), values.out);
    return;
  }
  const campaign = identifier(values.campaign, "campaign");
  const solver = solverPath(values.solver);
  const maxSeconds = integer(values["max-seconds"] ?? "90000", "--max-seconds", 1, 604_800);
  const maxEpochs = integer(values["max-epochs"] ?? "24", "--max-epochs", 1, 1024);
  const passEnv = values["pass-env"]?.split(",") ?? [];
  if (passEnv.some((name) => !/^[A-Z_][A-Z0-9_]*$/.test(name) || /CLANKDAR|REGISTRATION|SESSION_WRAP|ISSUER_JWK|ACTOR.*KEY|TOKEN_FILE/.test(name))) throw new Error("--pass-env must name explicit provider variables, never actor keys or registration tokens");
  const until = Date.now() + maxSeconds * 1000;
  const controller = new AbortController();
  let interrupted = false;
  const interrupt = () => { interrupted = true; controller.abort(); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  const submissions: unknown[] = [];
  let state: unknown = "time-limit";
  process.stderr.write(`Running your solver for at most ${maxSeconds}s / ${values.once ? 1 : maxEpochs} submitted epochs. Solver compute/inference costs are yours.\n`);
  try {
    while (Date.now() < until && submissions.length < maxEpochs) {
      const next = await signedFetch(base, key, `/v1/actors/${address}/campaigns/${campaign}/next`, "GET", undefined, controller.signal, until - Date.now());
      if (!object(next) || typeof next.state !== "string") throw new Error("hosted next response is malformed");
      state = next.state;
      if (next.state === "completed") break;
      if (next.state === "issued") {
        if (next.campaignId !== campaign || !Number.isSafeInteger(next.epoch) || typeof next.expiresAt !== "string" || !Array.isArray(next.challenges) || next.challenges.length < 1 || next.challenges.length > 64 || next.challenges.some((c) => !object(c) || typeof c.challengeId !== "string")) throw new Error("hosted session is malformed");
        const sessionId = identifier(typeof next.sessionId === "string" ? next.sessionId : undefined, "session");
        // Forward only public session fields, even if a server returns extra members.
        const session = { state: "issued", campaignId: campaign, epoch: next.epoch, sessionId, expiresAt: next.expiresAt, challenges: next.challenges } as IssuedSession;
        const responses = await runSolver(solver, session, controller.signal, until - Date.now(), passEnv);
        const result = await submit(base, key, sessionId, responses, controller.signal, Math.min(until, Date.parse(session.expiresAt)));
        // Keep bounded run output compact; full admissions remain retrievable by hash.
        submissions.push(object(result) ? { sessionId, evidenceHash: result.evidenceHash, verdict: result.verdict, passed: result.passed } : { sessionId });
        process.stderr.write(`Submitted epoch ${session.epoch + 1}; ${submissions.length} session(s) completed.\n`);
        if (values.once || submissions.length >= maxEpochs) { state = values.once ? "once" : "epoch-limit"; break; }
      } else if (!["waiting", "catching-up"].includes(next.state)) throw new Error("hosted next state is unsupported");
      if (values.once) break;
      const opensAt = object(next.next) && typeof next.next.opensAt === "string" ? Date.parse(next.next.opensAt) : NaN;
      const delay = Number.isFinite(opensAt) ? Math.max(1000, Math.min(30_000, opensAt - Date.now())) : 1000;
      await pause(Math.max(0, Math.min(delay, until - Date.now())), controller.signal);
    }
    if (Date.now() >= until) state = "time-limit";
  } catch (error) {
    if (!interrupted) throw error;
    state = "interrupted";
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
  emit({ ok: true, state, campaignId: campaign, profileUrl, submitted: submissions.length, submissions, maxSeconds, maxEpochs }, values.out);
  if (interrupted) process.exitCode = 130;
}

if (import.meta.main) {
  try { await main(); } catch (error) { console.error(error instanceof Error ? error.message : "hosted client failed"); process.exitCode = 2; }
}
