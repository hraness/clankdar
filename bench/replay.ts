#!/usr/bin/env bun
/**
 * Transcript replay: verify recorded tool-agent episodes against regenerated
 * deterministic environments.
 *
 *   bun bench/replay.ts results/agent/gpt-5-mini.jsonl
 *
 * For each row carrying a transcript, the instance is regenerated from the
 * manifest's suite version, bound to the recorded prompt/answer, and every
 * recorded tool output is re-derived. A pass verdict is also re-scored.
 * Any mismatch, missing env, or tampered transcript fails the run.
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { basename } from "node:path";
import { poolForVersion } from "../ladder/mod.ts";
import { replayEpisode } from "./agent.ts";
import { parseRun } from "./report.ts";
import { answerFormat, scoreAnswer } from "../ladder/family.ts";

export interface ReplayOutcome {
  row: string;
  replayed: boolean;
  reason?: string;
}

export function replayRun(path: string): ReplayOutcome[] {
  const bytes = readFileSync(path);
  const text = (path.endsWith(".gz") ? gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }) : bytes).toString("utf8");
  const run = parseRun(text, basename(path));
  const pool = run.manifest ? poolForVersion(String(run.manifest.suiteVersion)) : undefined;
  if (!pool) throw new Error("replay requires a versioned manifest");
  const outcomes: ReplayOutcome[] = [];
  for (const row of run.rows) {
    const key = `${row.family}:t${row.tier}:s${row.seed}`;
    const family = pool.find((f) => f.name === row.family);
    if (!family) throw new Error(`${key}: family not in suite pool`);
    const inst = family.generate(row.tier, row.seed);
    if (inst.prompt !== row.prompt || inst.answer !== row.expected) throw new Error(`${key}: regenerated instance disagrees with the recording`);
    const transcript = row.detail?.transcript;
    if (transcript === undefined) {
      if (row.error) { outcomes.push({ row: key, replayed: false, reason: `episode error: ${row.error}` }); continue; }
      if (!inst.env) { outcomes.push({ row: key, replayed: false, reason: "unaided row" }); continue; }
      throw new Error(`${key}: agent row is missing its transcript`);
    }
    if (!inst.env) throw new Error(`${key}: transcript present but the family provides no environment`);
    if (!replayEpisode(inst, transcript)) throw new Error(`${key}: tool transcript does not replay deterministically`);
    const scored = scoreAnswer(row.expected, row.response, answerFormat(row.family));
    if (scored.pass !== row.pass) throw new Error(`${key}: recorded verdict does not rescore`);
    outcomes.push({ row: key, replayed: true });
  }
  return outcomes;
}

export function main(args = process.argv.slice(2)): void {
  const { positionals, values } = parseArgs({ args, options: { help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
  if (values.help) { console.log("usage: bun bench/replay.ts RUN.jsonl[.gz] [...]"); return; }
  if (!positionals.length) throw new Error("supply at least one run file");
  for (const path of positionals) {
    const outcomes = replayRun(path);
    const replayed = outcomes.filter((o) => o.replayed).length;
    console.error(`${basename(path)}: ${replayed}/${outcomes.length} episodes replayed exactly`);
    for (const outcome of outcomes.filter((o) => !o.replayed)) console.error(`  ${outcome.row}: ${outcome.reason}`);
  }
}

if (import.meta.main) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "replay failed"); process.exitCode = 2; }
}
