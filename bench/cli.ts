#!/usr/bin/env bun
/**
 * Clankdar bench runner.
 *
 *   bun bench --adapter oracle --seeds 1-20
 *   bun bench --adapter openai:gpt-4o-mini --seeds 1-10 --tiers 0-3 --out results/gpt-4o-mini.jsonl
 *
 * Writes one JSONL row per attempted instance (to --out or stdout) and prints a
 * pass-rate summary by tier and family.
 */
import { adapterByName } from "./adapters.ts";
import { runBench, summarize } from "./run.ts";
import { FAMILIES } from "../ladder/mod.ts";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

function parseList(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function parseInts(spec: string): number[] {
  const out: number[] = [];
  for (const part of parseList(spec)) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) {
      for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i);
    } else if (/^\d+$/.test(part)) {
      out.push(Number(part));
    } else {
      throw new Error(`bad integer list item "${part}"`);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function usage(): never {
  console.error(`usage: bun bench --adapter <oracle|echo|openai:model> [options]

options:
  --seeds <spec>       seeds per cell, e.g. "1-20" or "1,2,3"   (default 1-10)
  --tiers <spec>       restrict tiers, e.g. "0-3"               (default: all)
  --families <list>    restrict families, comma-separated       (default: all)
  --concurrency <n>    parallel solver calls                    (default 4)
  --out <path>         JSONL output file                        (default: stdout rows suppressed)
  --list               list families and tiers, then exit`);
  process.exit(2);
}

const args = process.argv.slice(2);
const opt: Record<string, string | true> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith("--")) usage();
  const k = a.slice(2);
  if (i + 1 < args.length && !args[i + 1].startsWith("--")) opt[k] = args[++i];
  else opt[k] = true;
}

if (opt.list) {
  for (const f of FAMILIES) console.log(`${f.name}\ttiers ${f.tiers.join(",")}`);
  process.exit(0);
}

const adapterSpec = typeof opt.adapter === "string" ? opt.adapter : usage();
const adapter = adapterByName(adapterSpec);
const seeds = typeof opt.seeds === "string" ? parseInts(opt.seeds) : parseInts("1-10");
const tiers = typeof opt.tiers === "string" ? parseInts(opt.tiers) : undefined;
const families = typeof opt.families === "string" ? parseList(opt.families) : undefined;
const concurrency = typeof opt.concurrency === "string" ? Number(opt.concurrency) : 4;
const out = typeof opt.out === "string" ? opt.out : undefined;

if (out) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, "");
}

const results = await runBench(adapter, {
  families, tiers, seeds, concurrency,
  onResult: (r) => {
    if (out) appendFileSync(out, JSON.stringify(r) + "\n");
    const mark = r.error ? "ERR " : r.pass ? "pass" : "fail";
    console.error(`  [${mark}] ${r.family} t${r.tier} s${r.seed}${r.error ? ` — ${r.error}` : ""}`);
  },
});

const summary = summarize(adapter.name, results);
if (out) appendFileSync(out, JSON.stringify({ type: "summary", ...summary }) + "\n");

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.log(`\n${adapter.name}: ${summary.passed}/${summary.total} passed (${pct(summary.rate)})${summary.errors ? `, ${summary.errors} errors` : ""}`);
console.log("\nby tier:");
for (const [t, c] of Object.entries(summary.byTier).sort(([a], [b]) => Number(a) - Number(b)))
  console.log(`  t${t}: ${c.passed}/${c.n} (${pct(c.rate)})`);
console.log("\nby family:");
for (const [f, c] of Object.entries(summary.byFamily).sort())
  console.log(`  ${f}: ${c.passed}/${c.n} (${pct(c.rate)})`);
