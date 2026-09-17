import type { Adapter, BenchResult, BenchSummary, CellSummary } from "./adapter.ts";
import { answersMatch, type Family } from "../ladder/family.ts";
import { suiteCells } from "../ladder/mod.ts";

export interface BenchOptions {
  families?: string[];
  tiers?: number[];
  /** Seeds to draw per (family, tier) cell. */
  seeds: number[];
  /** Max in-flight solver calls. */
  concurrency?: number;
  onResult?: (r: BenchResult) => void;
}

/** Run an adapter over a suite slice and return one result row per instance. */
export async function runBench(adapter: Adapter, opts: BenchOptions): Promise<BenchResult[]> {
  const cells = suiteCells({ families: opts.families, tiers: opts.tiers });
  const work: { family: Family; tier: number; seed: number }[] = [];
  for (const { family, tier } of cells)
    for (const seed of opts.seeds) work.push({ family, tier, seed });

  const results: BenchResult[] = [];
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  let next = 0;
  async function worker() {
    while (next < work.length) {
      const w = work[next++];
      const started = performance.now();
      let r: BenchResult;
      try {
        const inst = w.family.generate(w.tier, w.seed);
        const response = await adapter.solve(inst);
        r = {
          adapter: adapter.name, family: w.family.name, tier: w.tier, seed: w.seed,
          prompt: inst.prompt, expected: inst.answer, response,
          pass: answersMatch(inst.answer, response),
          latencyMs: Math.round(performance.now() - started),
        };
      } catch (e) {
        r = {
          adapter: adapter.name, family: w.family.name, tier: w.tier, seed: w.seed,
          prompt: "", expected: "", response: "",
          pass: false, latencyMs: Math.round(performance.now() - started),
          error: e instanceof Error ? e.message : String(e),
        };
      }
      results.push(r);
      opts.onResult?.(r);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

const tally = (rs: BenchResult[]): CellSummary => {
  const passed = rs.filter((r) => r.pass).length;
  return { n: rs.length, passed, rate: rs.length ? passed / rs.length : 0 };
};

/** Aggregate results into pass rates overall, per tier, and per family. */
export function summarize(adapter: string, results: BenchResult[]): BenchSummary {
  const byTier: Record<number, BenchResult[]> = {};
  const byFamily: Record<string, BenchResult[]> = {};
  for (const r of results) {
    (byTier[r.tier] ??= []).push(r);
    (byFamily[r.family] ??= []).push(r);
  }
  return {
    adapter,
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    errors: results.filter((r) => r.error).length,
    rate: results.length ? results.filter((r) => r.pass).length / results.length : 0,
    byTier: Object.fromEntries(Object.entries(byTier).map(([t, rs]) => [t, tally(rs)])),
    byFamily: Object.fromEntries(Object.entries(byFamily).map(([f, rs]) => [f, tally(rs)])),
  };
}
