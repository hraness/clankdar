#!/usr/bin/env bun
/**
 * Calibration report: read complete per-model JSONL runs and rescore recorded replies.
 *
 *   bun bench/report.ts results/calibrate --json NEW-report.json
 *
 * Reports two numbers per cell:
 *   strict      — typed canonical response equals the answer
 *   finalAnswer — independently extracted final block equals the answer
 * The final-block diagnostic never changes strict scores or certifies capability.
 * Incomplete, duplicate, incompatible, or malformed runs are rejected.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { answerFormat, canonicalAnswer, scoreAnswer, SCORER_VERSION } from "../ladder/family.ts";
import { cellSupported, poolForVersion, KNOWN_SUITE_VERSIONS, FAMILIES, FRONTIER_FAMILIES } from "../ladder/mod.ts";
import { hashSuite } from "./run.ts";
import { wilson } from "./stats.ts";
import { list } from "./options.ts";

export interface TranscriptEntryRow {
  turn: number;
  role: "model" | "tool";
  text: string;
  tool?: string;
  ok?: boolean;
}

export interface RecordedRow {
  adapter: string;
  family: string;
  tier: number;
  seed: number;
  prompt: string;
  expected: string;
  response: string;
  pass: boolean;
  latencyMs: number;
  error?: string;
  truncated?: boolean;
  refused?: boolean;
  /** Agent-track episodes: bounded replayable transcript and diagnostics. */
  detail?: {
    transcript?: TranscriptEntryRow[];
    toolCalls?: number;
    turns?: number;
    episodeError?: string;
    [key: string]: unknown;
  };
}

export interface RecordedRun {
  model: string;
  rows: RecordedRow[];
  manifest: Record<string, unknown> | null;
  source: { file: string; sha256: string };
}

export const rowKey = (row: Pick<RecordedRow, "family" | "tier" | "seed">) => `${row.family}:t${row.tier}:s${row.seed}`;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a JSON object");
  return value as Record<string, unknown>;
};

export function parseRun(text: string, file = "run.jsonl"): RecordedRun {
  if (Buffer.byteLength(text) > 32 * 1024 * 1024) throw new Error("run exceeds 32 MiB");
  const lines = text.trim().split("\n");
  if (!text.trim() || lines.length > 10_002) throw new Error("empty or oversized run");
  const rows: RecordedRow[] = [];
  const keys = new Set<string>();
  let manifest: Record<string, unknown> | null = null;
  let summary: Record<string, unknown> | null = null;
  let pool: ReturnType<typeof poolForVersion> | undefined;
  for (const [index, line] of lines.entries()) {
    let decoded: unknown;
    try { decoded = JSON.parse(line); } catch { throw new Error(`invalid JSONL at line ${index + 1}`); }
    const row = object(decoded);
    if (row.type === "run") {
      if (index !== 0 || row.schemaVersion !== 2 || typeof row.runId !== "string" || !row.runId || typeof row.suiteHash !== "string" || !/^[a-f0-9]{64}$/.test(row.suiteHash) || typeof row.suiteVersion !== "string" || !KNOWN_SUITE_VERSIONS.includes(row.suiteVersion) || typeof row.scorerVersion !== "string") throw new Error("invalid run manifest");
      manifest = row;
      pool = poolForVersion(row.suiteVersion);
      continue;
    }
    if (row.type === "summary") {
      if (index !== lines.length - 1 || summary) throw new Error("summary must be the final record");
      summary = row;
      continue;
    }
    if (row.type !== undefined && row.type !== "result") throw new Error("unknown record type");
    if (manifest) {
      for (const field of ["runId", "suiteHash", "suiteVersion", "scorerVersion"]) if (row[field] !== manifest[field]) throw new Error(`result disagrees with manifest: ${field}`);
      if (row.type !== "result" || row.schemaVersion !== 2) throw new Error("invalid result schema");
    } else if (row.type === "result") throw new Error("versioned result requires a manifest");
    for (const field of ["adapter", "family", "prompt", "expected", "response"]) if (typeof row[field] !== "string" || (row[field] as string).length > 65_536) throw new Error(`invalid result field: ${field}`);
    if (!(row.adapter as string).length || (row.adapter as string).length > 200 || /[\x00-\x1f\x7f]/.test(row.adapter as string)) throw new Error("invalid model label");
    if (!Number.isInteger(row.seed) || (row.seed as number) < 0 || (row.seed as number) > 0xffffffff || !Number.isInteger(row.tier) || !cellSupported(row.family as string, row.tier as number, pool)) throw new Error("invalid instance identity");
    if (typeof row.pass !== "boolean" || typeof row.latencyMs !== "number" || !Number.isFinite(row.latencyMs) || row.latencyMs < 0) throw new Error("invalid verdict or latency");
    if (row.error !== undefined && (typeof row.error !== "string" || !row.error || row.pass)) throw new Error("invalid error record");
    if (!row.error && (!(row.prompt as string).length || canonicalAnswer(row.expected, answerFormat(row.family as string)) === null)) throw new Error("missing or invalid puzzle ground truth");
    if (row.truncated !== undefined && typeof row.truncated !== "boolean") throw new Error("invalid truncation flag");
    if (row.refused !== undefined && typeof row.refused !== "boolean") throw new Error("invalid refusal flag");
    if (row.detail !== undefined) {
      const detail = object(row.detail);
      if (detail.transcript !== undefined) {
        if (!Array.isArray(detail.transcript) || detail.transcript.length > 64) throw new Error("invalid transcript");
        for (const entry of detail.transcript) {
          const e = object(entry);
          if (!Number.isInteger(e.turn) || (e.turn as number) < 0 || (e.turn as number) > 64 || (e.role !== "model" && e.role !== "tool") || typeof e.text !== "string" || (e.text as string).length > 8_192) throw new Error("invalid transcript entry");
          if (e.tool !== undefined && (typeof e.tool !== "string" || !(e.tool as string).length || (e.tool as string).length > 64)) throw new Error("invalid transcript tool");
          if (e.ok !== undefined && typeof e.ok !== "boolean") throw new Error("invalid transcript flag");
        }
      }
      for (const field of ["toolCalls", "turns"]) if (detail[field] !== undefined && (!Number.isInteger(detail[field]) || (detail[field] as number) < 0 || (detail[field] as number) > 64)) throw new Error(`invalid episode field: ${field}`);
      if (detail.episodeError !== undefined && (typeof detail.episodeError !== "string" || (detail.episodeError as string).length > 64)) throw new Error("invalid episode error");
    }
    const record = row as unknown as RecordedRow;
    const key = rowKey(record);
    if (keys.has(key)) throw new Error("duplicate instance in run");
    if (rows.length && rows[0].adapter !== record.adapter) throw new Error("mixed models in one run");
    keys.add(key);
    rows.push(record);
  }
  if (!rows.length || !summary || summary.adapter !== rows[0].adapter || summary.total !== rows.length || summary.passed !== rows.filter((row) => row.pass).length || summary.errors !== rows.filter((row) => row.error).length) throw new Error("incomplete run or inconsistent summary");
  if (manifest) {
    if (!KNOWN_SUITE_VERSIONS.includes(manifest.suiteVersion as string) || manifest.scorerVersion !== SCORER_VERSION) throw new Error("unsupported suite or scorer version");
    if (manifest.instances !== rows.length || manifest.adapter !== rows[0].adapter || summary.runId !== manifest.runId || summary.suiteHash !== manifest.suiteHash || summary.scorerVersion !== manifest.scorerVersion) throw new Error("manifest coverage mismatch");
    const seeds = [...new Set(rows.map((row) => row.seed))].sort((a, b) => a - b);
    const cells = [...new Set(rows.map((row) => `${row.family}:t${row.tier}`))].sort();
    if (!Array.isArray(manifest.cells) || JSON.stringify(seeds) !== JSON.stringify(manifest.seeds) || JSON.stringify(cells) !== JSON.stringify([...manifest.cells].sort())) throw new Error("manifest selection mismatch");
    if (manifest.suiteHash !== hashSuite(rows.map((row) => ({ family: row.family, tier: row.tier, seed: row.seed, prompt: row.prompt, answer: row.expected })), String(manifest.suiteVersion))) throw new Error("suite hash does not match recorded puzzles");
  }
  return { model: rows[0].adapter, rows, manifest, source: { file, sha256: digest(text) } };
}

export function readRuns(dir: string): RecordedRun[] {
  const files = readdirSync(dir).filter((file) => /\.jsonl(?:\.gz)?$/.test(file)).sort();
  if (!files.length || files.length > 20) throw new Error("expected 1..20 JSONL run files");
  return files.map((file) => {
    const path = join(dir, file);
    if (!statSync(path).isFile() || statSync(path).size > 32 * 1024 * 1024) throw new Error("invalid run file");
    const bytes = readFileSync(path);
    const text = (file.endsWith(".gz") ? gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }) : bytes).toString("utf8");
    const run = parseRun(text, file);
    run.source.sha256 = digest(bytes);
    return run;
  });
}

export function buildReport(runs: RecordedRun[], excludedFamilies: string[] = []) {
  if (!runs.length || new Set(runs.map((run) => run.model)).size !== runs.length) throw new Error("empty report or duplicate model runs");
  if (excludedFamilies.some((family) => ![...FAMILIES, ...FRONTIER_FAMILIES].some((f) => f.name === family))) throw new Error("unknown excluded family");
  const keys = runs[0].rows.map(rowKey).sort();
  const puzzles = new Map<string, [string, string]>();
  const provenance = runs[0].manifest ? "versioned" : "legacy";
  for (const run of runs) {
    if ((run.manifest ? "versioned" : "legacy") !== provenance || JSON.stringify(run.rows.map(rowKey).sort()) !== JSON.stringify(keys)) throw new Error("runs do not cover the same suite");
    if (run.manifest && runs[0].manifest && ["suiteHash", "suiteVersion", "scorerVersion"].some((field) => run.manifest![field] !== runs[0].manifest![field])) throw new Error("incompatible suite or scorer versions");
    for (const row of run.rows) {
      if (!row.prompt || !row.expected) continue;
      const key = rowKey(row);
      const value: [string, string] = [row.prompt, row.expected];
      if (puzzles.has(key) && JSON.stringify(puzzles.get(key)) !== JSON.stringify(value)) throw new Error("identical instance IDs have different prompts or answers");
      puzzles.set(key, value);
    }
  }
  const suiteHash = provenance === "versioned"
    ? String(runs[0].manifest!.suiteHash)
    : digest(JSON.stringify(keys.map((key) => [key, ...(puzzles.get(key) ?? [null, null])])));
  const evaluate = (row: RecordedRow) => row.error || row.truncated || row.refused ? { pass: false, finalAnswerMatch: false, formatOnly: false } : scoreAnswer(row.expected, row.response, answerFormat(row.family));
  const tally = (rows: RecordedRow[]) => {
    const valid = rows.filter((row) => !row.error);
    const scores = valid.map(evaluate);
    const passed = scores.filter((score) => score.pass).length;
    const finalAnswerMatches = scores.filter((score) => score.finalAnswerMatch).length;
    return {
      total: rows.length, n: valid.length, errors: rows.length - valid.length, passed,
      strict: valid.length ? passed / valid.length : null,
      interval95: wilson(passed, valid.length), finalAnswerMatches,
      finalAnswer: valid.length ? finalAnswerMatches / valid.length : null,
      formatOnly: scores.filter((score) => score.formatOnly).length,
    };
  };
  const models = runs.map((run) => {
    const rows = [...run.rows].sort((a, b) => rowKey(a).localeCompare(rowKey(b), "en"));
    const eligible = rows.filter((row) => !excludedFamilies.includes(row.family));
    const group = (key: (row: RecordedRow) => string) => Object.fromEntries([...new Set(eligible.map(key))].sort().map((name) => [name, tally(eligible.filter((row) => key(row) === name))]));
    return {
      model: run.model, all: tally(rows), eligible: tally(eligible), excluded: rows.length - eligible.length,
      byTier: group((row) => String(row.tier)), byFamily: group((row) => row.family),
      byCell: group((row) => `${row.family}:t${row.tier}`), bySeed: group((row) => String(row.seed)),
      rescored: { lostPasses: rows.filter((row) => !row.error && row.pass && !evaluate(row).pass).length, gainedPasses: rows.filter((row) => !row.error && !row.pass && evaluate(row).pass).length },
    };
  }).sort((a, b) => (b.eligible.strict ?? -1) - (a.eligible.strict ?? -1) || a.model.localeCompare(b.model, "en"));
  return {
    schemaVersion: 2, scorerVersion: SCORER_VERSION, provenance, suiteHash,
    seeds: [...new Set(runs[0].rows.map((row) => row.seed))].sort((a, b) => a - b),
    cells: [...new Set(runs[0].rows.map((row) => `${row.family}:t${row.tier}`))].sort(),
    excludedFamilies: [...excludedFamilies].sort(),
    sources: runs.map((run) => run.source).sort((a, b) => a.file.localeCompare(b.file, "en")), models,
  };
}

export type CalibrationReport = ReturnType<typeof buildReport>;

export function main(args = process.argv.slice(2)): void {
  const { values, positionals } = parseArgs({ args, options: { json: { type: "string" }, exclude: { type: "string" }, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
  if (values.help) { console.log("usage: bun report RUN-DIRECTORY [--json NEW-report.json] [--exclude family,...]"); return; }
  if (positionals.length !== 1) throw new Error("supply one run directory");
  const report = buildReport(readRuns(positionals[0]), values.exclude ? list(values.exclude) : []);
  if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  else console.log(JSON.stringify(report, null, 2));
  for (const model of report.models) console.error(`${model.model}: ${model.eligible.passed}/${model.eligible.n} strict; ${model.eligible.finalAnswerMatches}/${model.eligible.n} final-block; ${model.eligible.errors} errors; ${model.excluded} excluded`);
}

if (import.meta.main) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "report failed"); process.exitCode = 2; }
}
