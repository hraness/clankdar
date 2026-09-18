#!/usr/bin/env bun
/**
 * Calibration driver: run several models over the same suite slice and print a
 * per-tier pass-rate table for comparison.
 *
 *   CLANKDAR_BASE_URL=… bun bench/calibrate.ts \
 *     --models openai/gpt-4o-mini,google/gemini-2.5-flash-lite --seeds 1-10
 *
 * Creates a new run directory and exclusive per-model JSONL files. Interrupted
 * runs remain available for audit; existing data is never overwritten or
 * silently resumed. Model calls require an explicit request budget.
 */
import { parseArgs } from "node:util";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openai, openaiAgent } from "./adapters.ts";
import { commonOptions, integer, list, requestBudget, selection } from "./options.ts";
import { recordRun, runManifest, percent } from "./record.ts";

export async function main(args = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({ args, options: { ...commonOptions, models: { type: "string" } }, strict: true, allowPositionals: false });
  if (values.help) {
    console.log("usage: bun calibrate --models <provider/model,...> [--seeds 1-10] [--tiers 0-6] [--out NEW-DIRECTORY] [--execute --max-requests N]\nDefault: dry run. --execute enables bounded API calls. Common options match bun bench --help.");
    return 0;
  }
  if (!values.models) throw new Error("--models is required");
  const models = list(values.models, 20);
  const opts = selection(values);
  const maxTokens = integer(values["max-tokens"] ?? "4096", 32_768);
  const maxRequests = values["max-requests"] ? integer(values["max-requests"], 30_000) : undefined;
  const budget = maxRequests ? requestBudget(maxRequests) : undefined;
  const agentic = opts.suite === "agent";
  const adapters = models.map((model) =>
    (agentic ? openaiAgent : openai)({ model, name: model, maxTokens, timeoutMs: opts.timeoutMs, beforeRequest: budget?.beforeRequest }));
  const manifest = runManifest(adapters[0], opts);
  const instances = manifest.instances * models.length;
  // Agent episodes make one request per turn; budgets cap turns per episode.
  const perInstance = agentic ? 24 : 3;
  if (!values.execute || values["dry-run"]) {
    console.log(JSON.stringify({ dryRun: true, models, instances, maximumRequests: instances * perInstance, maxTokens, suiteHash: manifest.suiteHash, suiteVersion: manifest.suiteVersion, scorerVersion: manifest.scorerVersion, seeds: manifest.seeds, cells: manifest.cells, endpoint: adapters[0].config?.endpoint }, null, 2));
    return 0;
  }
  if (!maxRequests || maxRequests < instances * perInstance) throw new Error(`--execute requires --max-requests at least ${perInstance}× the total instance count`);
  for (const adapter of adapters) adapter.validate?.();
  const out = values.out ?? join("results", "calibrate", randomUUID());
  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(out, { mode: 0o700 });
  const summaries = [];
  for (const adapter of adapters) {
    const safe = adapter.name.replace(/[^a-z0-9.-]/gi, "_").slice(0, 100);
    const digest = createHash("sha256").update(adapter.name).digest("hex").slice(0, 12);
    const summary = await recordRun(adapter, opts, join(out, `${safe}-${digest}.jsonl`));
    summaries.push(summary);
    console.error(`${adapter.name}: ${summary.passed}/${summary.attempted} (${percent(summary.rate)}), ${summary.errors} errors`);
    if (summary.attempted === 0) break;
  }
  // Comparison table: rows = models (sorted by overall rate), cols = tiers.
  for (const summary of summaries.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1))) {
    console.error(`${summary.adapter}: ${Object.entries(summary.byTier).map(([tier, cell]) => `t${tier} ${percent(cell.rate)}`).join(" | ")}`);
  }
  console.log(JSON.stringify({ type: "calibration", directory: out, requests: budget!.used(), models: summaries }));
  return summaries.length !== models.length || summaries.some((summary) => summary.errors) ? 1 : 0;
}

if (import.meta.main) {
  try { process.exitCode = await main(); } catch (error) { console.error(error instanceof Error ? error.message : "calibration failed"); process.exitCode = 2; }
}
