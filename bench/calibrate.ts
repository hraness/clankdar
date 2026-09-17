#!/usr/bin/env bun
/**
 * Calibration driver: run several models over the same suite slice and print a
 * per-tier pass-rate table for comparison.
 *
 *   CLANKDAR_BASE_URL=… bun bench/calibrate.ts \
 *     --models openai/gpt-4o-mini,google/gemini-2.5-flash-lite --seeds 1-10
 *
 * Writes results/calibrate/<safe-model-name>.jsonl (one row per instance, plus a
 * trailing summary record) so runs are resumable and auditable.
 */
import { openai } from "./adapters.ts";
import { runBench, summarize, type BenchOptions } from "./run.ts";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const opt: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) opt[args[i].replace(/^--/, "")] = args[i + 1];

const parseInts = (spec: string): number[] => {
  const out: number[] = [];
  for (const part of spec.split(",")) {
    const m = part.trim().match(/^(\d+)-(\d+)$/);
    if (m) for (let i = +m[1]; i <= +m[2]; i++) out.push(i);
    else out.push(+part);
  }
  return [...new Set(out)];
};

if (!opt.models) {
  console.error("usage: bun bench/calibrate.ts --models <m1,m2,…> [--seeds 1-10] [--tiers 0-6] [--concurrency 8]");
  process.exit(2);
}

const seeds = parseInts(opt.seeds ?? "1-10");
const tiers = opt.tiers ? parseInts(opt.tiers) : undefined;
const concurrency = Number(opt.concurrency ?? 8);
const outDir = opt.out ?? "results/calibrate";
mkdirSync(outDir, { recursive: true });

const summaries = new Map<string, ReturnType<typeof summarize>>();

for (const model of opt.models.split(",")) {
  const spec = model.trim();
  const adapter = openai({ model: spec, name: spec });
  const file = `${outDir}/${spec.replace(/[^a-z0-9.-]+/gi, "_")}.jsonl`;
  writeFileSync(file, "");
  const t0 = Date.now();
  const results = await runBench(adapter, {
    seeds, tiers, concurrency,
    onResult: (r) => {
      appendFileSync(file, JSON.stringify(r) + "\n");
      const mark = r.error ? "ERR " : r.pass ? "·" : "✗";
      process.stderr.write(mark);
    },
  });
  const s = summarize(adapter.name, results);
  appendFileSync(file, JSON.stringify({ type: "summary", ...s }) + "\n");
  summaries.set(spec, s);
  console.error(`\n${spec}: ${s.passed}/${s.total} (${(s.rate * 100).toFixed(1)}%), ${s.errors} err, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// Comparison table: rows = models (sorted by overall rate), cols = tiers.
const allTiers = [...new Set([...summaries.values()].flatMap((s) => Object.keys(s.byTier).map(Number)))].sort((a, b) => a - b);
const pct = (x?: number) => (x === undefined ? "  - " : `${Math.round(x * 100)}`.padStart(3) + "%");
console.log(`\n${"model".padEnd(34)} ${allTiers.map((t) => `t${t}`.padStart(5)).join("")}   all`);
for (const [m, s] of [...summaries.entries()].sort((a, b) => b[1].rate - a[1].rate)) {
  console.log(`${m.padEnd(34)} ${allTiers.map((t) => pct(s.byTier[t]?.rate).padStart(5)).join("")}  ${pct(s.rate)}`);
}
