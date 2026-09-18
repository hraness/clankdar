import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SCORER_VERSION, AGENT_SUITE_VERSION } from "../ladder/mod.ts";
import { AGENT_PROTOCOL_VERSION } from "./adapters.ts";
import type { Adapter } from "./adapter.ts";
import { prepareSuite, runBench, summarize, type BenchOptions } from "./run.ts";

export function exclusiveWriter(path?: string) {
  if (path) mkdirSync(dirname(path), { recursive: true });
  const fd = path ? openSync(path, "wx", 0o600) : null;
  return {
    write: (record: unknown) => {
      const text = JSON.stringify(record) + "\n";
      if (fd === null) process.stdout.write(text);
      else {
        const bytes = Buffer.from(text);
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset);
          if (!written) throw new Error("result write made no progress");
          offset += written;
        }
      }
    },
    close: () => { if (fd !== null) closeSync(fd); },
  };
}

export function runManifest(adapter: Adapter, opts: BenchOptions) {
  const suite = prepareSuite(opts);
  let revision: string | null = null;
  let dirty: boolean | null = null;
  try {
    revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch {}
  return {
    type: "run", schemaVersion: 2, runId: opts.runId ?? randomUUID(), startedAt: new Date().toISOString(),
    mode: "benchmark", adapter: adapter.name, suiteVersion: suite.suiteVersion, scorerVersion: SCORER_VERSION,
    suiteHash: suite.suiteHash, instances: suite.instances.length, seeds: [...opts.seeds].sort((a, b) => a - b),
    ...(suite.suiteVersion === AGENT_SUITE_VERSION ? { protocol: AGENT_PROTOCOL_VERSION } : {}),
    cells: [...new Set(suite.instances.map((i) => `${i.family}:t${i.tier}`))],
    config: adapter.config ?? {}, concurrency: opts.concurrency ?? 4, timeoutMs: opts.timeoutMs ?? 120_000,
    source: { revision, dirty }, runtime: `bun@${Bun.version}`,
  };
}

export async function recordRun(adapter: Adapter, opts: BenchOptions, path?: string) {
  adapter.validate?.();
  const manifest = runManifest(adapter, opts);
  const output = exclusiveWriter(path);
  try {
    output.write(manifest);
    const results = await runBench(adapter, { ...opts, runId: manifest.runId, onResult: (row) => {
      output.write(row);
      opts.onResult?.(row);
    } });
    const summary = summarize(adapter.name, results);
    output.write({ type: "summary", schemaVersion: 2, runId: manifest.runId, suiteHash: manifest.suiteHash, scorerVersion: SCORER_VERSION, ...summary });
    return summary;
  } finally {
    output.close();
  }
}

export const percent = (rate: number | null | undefined) => rate == null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
