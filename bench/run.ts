import { createHash, randomUUID } from "node:crypto";
import { AdapterError, type Adapter, type BenchResult, type BenchSummary, type CellSummary } from "./adapter.ts";
import { answerFormat, canonicalAnswer, scoreAnswer, SCORER_VERSION, MAX_ANSWER_LENGTH, type Instance } from "../ladder/family.ts";
import { suiteCells, suiteVersion, SUITE_VERSION, type SuiteName } from "../ladder/mod.ts";
import { oracle } from "./adapters.ts";
import { wilson } from "./stats.ts";

export interface BenchOptions {
  families?: string[];
  tiers?: number[];
  /** Which registered suite to draw cells from. */
  suite?: SuiteName;
  /** Seeds to draw per (family, tier) cell. */
  seeds: number[];
  /** Max in-flight solver calls. */
  concurrency?: number;
  timeoutMs?: number;
  runId?: string;
  onResult?: (r: BenchResult) => void;
}

export function hashSuite(instances: readonly Instance[], version: string): string {
  const ordered = [...instances].sort((a, b) => a.family.localeCompare(b.family, "en") || a.tier - b.tier || a.seed - b.seed);
  return createHash("sha256").update(JSON.stringify([version, ...ordered.map((i) => [i.family, i.tier, i.seed, i.prompt, i.answer, answerFormat(i.family)])])).digest("hex");
}

export function prepareSuite(opts: BenchOptions): { instances: Instance[]; suiteHash: string; suiteVersion: string } {
  if (!opts.seeds.length || opts.seeds.length > 1000 || new Set(opts.seeds).size !== opts.seeds.length || opts.seeds.some((seed) => !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) throw new Error("supply 1..1000 distinct uint32 seeds");
  const concurrency = opts.concurrency ?? 4;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error("concurrency must be an integer in 1..64");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("timeoutMs must be an integer in 1..600000");
  const version = suiteVersion(opts.suite ?? "v2");
  const cells = suiteCells(opts);
  if (cells.length * opts.seeds.length > 10_000) throw new Error("suite exceeds 10000 instances");
  const seeds = [...opts.seeds].sort((a, b) => a - b);
  const instances = cells.flatMap(({ family, tier }) => seeds.map((seed) => {
    try {
      return family.generate(tier, seed);
    } catch (error) {
      throw new Error(`generation failed at ${family.name}:t${tier}:s${seed}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
  for (const instance of instances) {
    if (!instance.prompt || instance.prompt.length > 65_536 || canonicalAnswer(instance.answer, answerFormat(instance.family)) === null) throw new Error(`invalid generated instance: ${instance.family}:${instance.tier}:${instance.seed}`);
  }
  const suiteHash = hashSuite(instances, version);
  return { instances, suiteHash, suiteVersion: version };
}

/** Run an adapter over a suite slice and return one result row per instance. */
export async function runBench(adapter: Adapter, opts: BenchOptions): Promise<BenchResult[]> {
  const { instances, suiteHash, suiteVersion } = prepareSuite(opts);
  const runId = opts.runId ?? randomUUID();
  const results = new Array<BenchResult>(instances.length);
  const stop = new AbortController();
  let next = 0;
  async function worker() {
    while (next < instances.length && !stop.signal.aborted) {
      const index = next++;
      const inst = instances[index];
      const started = performance.now();
      const controller = new AbortController();
      const signal = AbortSignal.any([stop.signal, controller.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result: BenchResult = {
        type: "result", schemaVersion: 2, runId, suiteVersion, suiteHash, scorerVersion: SCORER_VERSION,
        adapter: adapter.name, family: inst.family, tier: inst.tier, seed: inst.seed,
        prompt: inst.prompt, expected: inst.answer, response: "", pass: false, finalAnswerMatch: false, latencyMs: 0,
      };
      try {
        const puzzle = Object.freeze({ family: inst.family, tier: inst.tier, prompt: inst.prompt });
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new DOMException("timeout", "TimeoutError")); }, opts.timeoutMs ?? 120_000);
        });
        // Agent-capable adapters play the TOOL/FINAL protocol against the
        // instance's server-side env; other adapters get a single text turn.
        const attempt = adapter === oracle
          ? Promise.resolve(inst.answer)
          : adapter.agent && inst.env
            ? adapter.agent(puzzle, inst.env, { signal })
            : adapter.solve(puzzle, { signal });
        const solved = await Promise.race([attempt, timeout]);
        const detail = typeof solved === "string" ? { text: solved } : solved;
        if (!detail || typeof detail.text !== "string" || detail.text.length > MAX_ANSWER_LENGTH) throw new AdapterError("response_too_large");
        const { text, ...metadata } = detail;
        result.response = text;
        result.detail = metadata;
        result.truncated = detail.finishReason === "length";
        result.refused = detail.refused === true || detail.finishReason === "content_filter";
        if (!result.truncated && !result.refused) {
          const scored = scoreAnswer(inst.answer, text, answerFormat(inst.family));
          result.pass = scored.pass;
          result.finalAnswerMatch = scored.finalAnswerMatch;
        }
      } catch (error) {
        result.error = error instanceof AdapterError ? error.message : controller.signal.aborted || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) ? "timeout" : "adapter_failed";
      } finally {
        clearTimeout(timer);
      }
      result.latencyMs = Math.round(performance.now() - started);
      results[index] = result;
      try { opts.onResult?.(result); } catch (error) { stop.abort(); throw error; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, instances.length) }, worker));
  return results;
}

const tally = (rs: BenchResult[]): CellSummary => {
  const errors = rs.filter((r) => r.error).length;
  const attempted = rs.length - errors;
  const passed = rs.filter((r) => !r.error && r.pass).length;
  return { n: rs.length, attempted, errors, passed, rate: attempted ? passed / attempted : null, interval95: wilson(passed, attempted), finalAnswerMatches: rs.filter((r) => !r.error && r.finalAnswerMatch).length };
};

/** Aggregate results into pass rates overall, per tier, and per family. */
export function summarize(adapter: string, results: BenchResult[]): BenchSummary {
  if (results.some((r) => r.adapter !== adapter)) throw new Error("cannot mix adapters in one summary");
  const group = (key: (r: BenchResult) => string) => {
    const groups = new Map<string, BenchResult[]>();
    for (const row of results) {
      const label = key(row);
      const rows = groups.get(label) ?? [];
      rows.push(row);
      groups.set(label, rows);
    }
    return Object.fromEntries([...groups.entries()].map(([label, rows]) => [label, tally(rows)]));
  };
  const total = tally(results);
  return {
    adapter, total: results.length, ...total, coverage: results.length ? total.attempted / results.length : 0,
    byTier: group((r) => String(r.tier)), byFamily: group((r) => r.family),
    byCell: group((r) => `${r.family}:t${r.tier}`), bySeed: group((r) => String(r.seed)),
  };
}
