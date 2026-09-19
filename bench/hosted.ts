#!/usr/bin/env bun
/**
 * The hosted issuer surface — the gate service plus its published
 * transparency log, in one HTTP deployment.
 *
 *   bun bench/hosted.ts serve --key verifier.json --policy policy.json --dir state/ [--pool pool.json] [--host H] [--port N] [--open-total N] [--open-per-subject N] [--issue-window MAX:SEC]
 *   bun bench/hosted.ts head --dir state/ --key verifier.json
 *
 * A self-hosted gate keeps its ledger private and answers admission
 * traffic; a hosted issuer additionally publishes the evidence a third
 * party needs to hold it accountable. Every gate route is served unchanged
 * — the hosted service delegates to the same request handler — and three
 * read endpoints publish the derived clankdar-tlog-v1 view:
 *
 *   GET /tlog                  the full signed log {head, entries}
 *   GET /tlog/head             just the signed head — what a witness pins
 *   GET /tlog/proof/:sessionId inclusion evidence via proveSession
 *
 * Every tlog read rebuilds the log from the ledger and re-signs the head,
 * so a served head always commits the current ledger — the cost is
 * O(ledger size) per request and there is no cache that could go stale. A
 * production deployment would rebuild on append or on a bounded interval.
 * The ledger itself stays private: entries carry record digests, never
 * seeds, tickets, responses, or admissions, and the state dir is 0700.
 *
 * Scope: hosting publishes evidence; it does not create trust. The issuer
 * can still self-mint (a verifier can always answer its own oracle) and can
 * still fork — serve one log to one client and a different log to another.
 * The signed head is the accountability hook: an external witness that pins
 * /tlog/head over time or across vantage points feeds the equivocation
 * check, but heads still have to reach a common witness to be compared.
 * This is a reference surface — TLS termination, client authentication,
 * and witnessed co-signing are not implemented.
 */
import { parseArgs } from "node:util";
import { chmodSync, readFileSync } from "node:fs";
import type { VerifierJwk } from "./attest.ts";
import { gateHandler, parsePolicy, SESSION_ID, type GatePolicy, type GateRateLimits } from "./gate.ts";
import { parsePool, type HoldoutPool } from "./holdout.ts";
import { integer } from "./options.ts";
import { GateStore } from "./store.ts";
import { buildLog, proveSession, type TransparencyLog } from "./tlog.ts";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * One service composing the gate and the derived transparency log. The
 * gate's own routes (sessions, responses, receipts, policy, healthz)
 * delegate to `gateHandler` — nothing is re-implemented here. The tlog
 * routes are served first and never reach the gate:
 *
 * - `GET /tlog` → the current `TransparencyLog` ({head, entries}), rebuilt
 *   from the ledger and re-signed on every request;
 * - `GET /tlog/head` → just the signed `TlogHead`, the artifact an
 *   external witness pins;
 * - `GET /tlog/proof/:sessionId` → `SessionProof` under the current head,
 *   or 404 when no session entry carries that id.
 *
 * The state dir is forced to 0700 (the ledger holds seeds and answers);
 * published entries expose digests and metadata only. `close()` stops the
 * server and closes the store the service opened.
 */
export function serveHosted(opts: {
  /** Gate state dir holding gate-state.jsonl; created 0700 if absent. */
  dir: string;
  policy: GatePolicy;
  verifierJwk: VerifierJwk;
  rateLimits?: GateRateLimits;
  /** Pool supplying the policy's `h:` cells; required when the policy names any. */
  pool?: HoldoutPool;
  host?: string;
  port?: number;
}): { url: string; close: () => void; store: GateStore } {
  const store = GateStore.open(opts.dir);
  chmodSync(opts.dir, 0o700); // enforce on a pre-existing dir too; mkdir mode only covers creation
  let gate: (req: Request) => Promise<Response>;
  try {
    gate = gateHandler({
      policy: opts.policy, verifierJwk: opts.verifierJwk, store,
      rateLimits: opts.rateLimits, pool: opts.pool,
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const err = (status: number, message: string) => json({ error: message }, status);
  const currentLog = (): TransparencyLog | null => {
    try {
      return buildLog({ dir: opts.dir, verifierJwk: opts.verifierJwk });
    } catch {
      return null;
    }
  };
  const server = Bun.serve({
    hostname: opts.host ?? "127.0.0.1",
    port: opts.port ?? 8787,
    fetch: async (req) => {
      const { pathname } = new URL(req.url);
      if (req.method === "GET" && pathname === "/tlog") {
        const log = currentLog();
        return log ? json(log) : err(500, "transparency log unavailable");
      }
      if (req.method === "GET" && pathname === "/tlog/head") {
        const log = currentLog();
        return log ? json(log.head) : err(500, "transparency log unavailable");
      }
      const proofMatch = new RegExp(`^/tlog/proof/(${SESSION_ID.source.slice(1, -1)})$`).exec(pathname);
      if (req.method === "GET" && proofMatch) {
        const log = currentLog();
        if (!log) return err(500, "transparency log unavailable");
        if (!log.entries.some((entry) => entry.type === "session" && entry.sessionId === proofMatch[1])) {
          return err(404, "no logged session with that id");
        }
        try {
          return json(proveSession(log, proofMatch[1]));
        } catch {
          return err(500, "transparency log failed check");
        }
      }
      return gate(req);
    },
  });
  return {
    url: `http://${server.hostname}:${server.port}`,
    store,
    close: () => {
      server.stop(true);
      store.close();
    },
  };
}

function loadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${message(error)}`);
  }
}

const USAGE = `usage: hosted <command>
  serve --key K --policy P --dir STATE [--pool POOL.json] [--host H] [--port N] [--open-total N] [--open-per-subject N] [--issue-window MAX:SEC]
  head --dir STATE --key K`;

export function main(args = process.argv.slice(2)): void {
  const [command, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      key: { type: "string" }, policy: { type: "string" }, dir: { type: "string" }, pool: { type: "string" },
      host: { type: "string" }, port: { type: "string" },
      "open-total": { type: "string" }, "open-per-subject": { type: "string" }, "issue-window": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true, strict: true,
  });
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  const need = (...names: (string | undefined)[]) => {
    if (names.some((n) => n === undefined)) throw new Error(`${command} requires more options.\n${USAGE}`);
  };
  const loadPool = () => (values.pool !== undefined ? parsePool(loadJson(values.pool)) : undefined);

  if (command === "serve") {
    need(values.key, values.policy, values.dir);
    const rateLimits: GateRateLimits = {};
    if (values["open-total"] !== undefined) rateLimits.openTotal = integer(values["open-total"], 1_000_000);
    if (values["open-per-subject"] !== undefined) rateLimits.openPerSubject = integer(values["open-per-subject"], 1_000_000);
    if (values["issue-window"] !== undefined) {
      const [max, seconds] = values["issue-window"].split(":");
      if (max === undefined || seconds === undefined) throw new Error("--issue-window expects MAX:SECONDS");
      rateLimits.issueWindow = { max: integer(max, 1_000_000), seconds: integer(seconds, 31_536_000) };
    }
    const pool = loadPool();
    const hosted = serveHosted({
      dir: values.dir!,
      policy: parsePolicy(loadJson(values.policy!), { pool }),
      verifierJwk: loadJson(values.key!) as VerifierJwk,
      rateLimits: Object.keys(rateLimits).length ? rateLimits : undefined,
      pool,
      host: values.host,
      port: values.port !== undefined ? integer(values.port, 65535) : undefined,
    });
    console.error(`clankdar-hosted listening at ${hosted.url} (gate + tlog: /tlog, /tlog/head, /tlog/proof/:sessionId)`);
    return;
  }
  if (command === "head") {
    need(values.dir, values.key);
    const { head } = buildLog({ dir: values.dir!, verifierJwk: loadJson(values.key!) as VerifierJwk });
    console.log(JSON.stringify(head, null, 2));
    return;
  }
  throw new Error(`unknown command: ${command}.\n${USAGE}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(message(error));
    process.exitCode = 2;
  }
}
