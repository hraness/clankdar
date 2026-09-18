#!/usr/bin/env bun
/**
 * Drift monitor: scheduled clankdar-gate probes against one model endpoint,
 * recorded as a replayable score-band series.
 *
 *   bun bench/drift.ts run --key verifier.json --policy policy.json --adapter openai:gpt-4.1 --rounds 5 --series drift.jsonl --execute --max-requests 100
 *   bun bench/drift.ts report --series drift.jsonl
 *   bun bench/drift.ts baseline --series drift.jsonl --out baseline.json
 *   bun bench/drift.ts compare --series drift.jsonl --baseline baseline.json [--threshold 0.2]
 *
 * Every run round is a signed clankdar-gate admission — the series is evidence,
 * not telemetry. `compare` exits nonzero when a cell or the overall band drops
 * below the pinned baseline by more than --threshold, so CI can gate on model
 * regressions. Score bands describe the probed endpoint under the recorded
 * policy; they are not a certification of the provider.
 */
import { parseArgs } from "node:util";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { probe, type Admission, type AdmissionBody, type GatePolicy } from "./gate.ts";
import { parsePolicy } from "./gate.ts";
import type { Adapter } from "./adapter.ts";
import { adapterByName, openai } from "./adapters.ts";
import { integer, requestBudget } from "./options.ts";
import type { VerifierJwk } from "./attest.ts";

export interface DriftRecord {
  type: "probe";
  ts: string;
  adapter: string;
  sessionId: string;
  /** Cells attempted, in challenge order. */
  cells: string[];
  /** Cells that produced a passing receipt. */
  passedCells: string[];
  passed: number;
  challenges: number;
  verdict: boolean;
  /** The signed admission — replayable evidence for this round. */
  admission: Admission;
}

export interface CellBand {
  n: number;
  passed: number;
  rate: number;
}

export interface DriftReport {
  records: number;
  sessions: number;
  challenges: number;
  passed: number;
  rate: number;
  admitted: number;
  cells: Record<string, CellBand>;
  adapters: string[];
}

export interface DriftBaseline {
  kind: "drift-baseline";
  adapter: string;
  createdAt: string;
  report: DriftReport;
}

/** Run `rounds` probe sessions against the adapter, appending each record to the series file. */
export async function runDrift(opts: {
  policy: GatePolicy;
  verifierJwk: VerifierJwk;
  adapter: Adapter;
  rounds: number;
  seriesPath?: string;
}): Promise<DriftRecord[]> {
  const records: DriftRecord[] = [];
  for (let round = 0; round < opts.rounds; round++) {
    const { admissions } = await probe({ policy: opts.policy, verifierJwk: opts.verifierJwk, adapter: opts.adapter, rounds: 1 });
    const admission = admissions[0];
    const body = JSON.parse(admission.payload) as AdmissionBody;
    const cellById = new Map(body.challenges.map((c) => [c.challengeId, `${c.family}:t${c.tier}`]));
    const passedCells: string[] = [];
    for (const receipt of body.receipts) {
      const rb = JSON.parse(receipt.payload) as { challenge: { challengeId: string }; verdict: { pass: boolean } };
      if (rb.verdict.pass) {
        const cell = cellById.get(rb.challenge.challengeId);
        if (cell) passedCells.push(cell);
      }
    }
    const record: DriftRecord = {
      type: "probe",
      ts: body.verdict.decidedAt,
      adapter: opts.adapter.name,
      sessionId: body.sessionId,
      cells: body.challenges.map((c) => `${c.family}:t${c.tier}`),
      passedCells,
      passed: body.verdict.passed,
      challenges: body.challenges.length,
      verdict: body.verdict.pass,
      admission,
    };
    records.push(record);
    if (opts.seriesPath) appendFileSync(opts.seriesPath, JSON.stringify(record) + "\n");
  }
  return records;
}

/** Aggregate a series into per-cell and overall pass-rate bands. */
export function driftReport(records: DriftRecord[]): DriftReport {
  const cells: Record<string, CellBand> = {};
  let passed = 0;
  let challenges = 0;
  let admitted = 0;
  const adapters = new Set<string>();
  for (const record of records) {
    adapters.add(record.adapter);
    challenges += record.cells.length;
    passed += record.passedCells.length;
    if (record.verdict) admitted++;
    for (const cell of record.cells) cells[cell] = cells[cell] ?? { n: 0, passed: 0, rate: 0 };
    for (const cell of record.cells) cells[cell].n++;
    for (const cell of record.passedCells) cells[cell].passed++;
  }
  for (const band of Object.values(cells)) band.rate = band.n ? band.passed / band.n : 0;
  return {
    records: records.length, sessions: records.length, challenges, passed,
    rate: challenges ? passed / challenges : 0, admitted,
    cells, adapters: [...adapters],
  };
}

/** Pin a series as the comparison baseline. */
export function makeBaseline(records: DriftRecord[], adapter: string, now = new Date()): DriftBaseline {
  if (!records.length) throw new Error("cannot baseline an empty series");
  return { kind: "drift-baseline", adapter, createdAt: now.toISOString(), report: driftReport(records) };
}

export interface CompareResult {
  ok: boolean;
  threshold: number;
  alerts: string[];
}

/**
 * Compare a current report against a pinned baseline. A cell alerts when its
 * pass rate drops more than `threshold` below baseline (cells absent from the
 * baseline are ignored; new cells never alert). The overall band alerts the
 * same way.
 */
export function compareDrift(current: DriftReport, baseline: DriftBaseline, threshold = 0.2): CompareResult {
  const alerts: string[] = [];
  for (const [cell, base] of Object.entries(baseline.report.cells)) {
    const now = current.cells[cell];
    if (!now) {
      alerts.push(`${cell}: absent from current series (baseline ${base.passed}/${base.n} = ${(base.rate * 100).toFixed(1)}%)`);
      continue;
    }
    const drop = base.rate - now.rate;
    if (drop > threshold) alerts.push(`${cell}: ${(base.rate * 100).toFixed(1)}% → ${(now.rate * 100).toFixed(1)}% (drop ${(drop * 100).toFixed(1)}pt > ${(threshold * 100).toFixed(0)}pt)`);
  }
  const overallDrop = baseline.report.rate - current.rate;
  if (overallDrop > threshold) alerts.push(`overall: ${(baseline.report.rate * 100).toFixed(1)}% → ${(current.rate * 100).toFixed(1)}% (drop ${(overallDrop * 100).toFixed(1)}pt > ${(threshold * 100).toFixed(0)}pt)`);
  return { ok: alerts.length === 0, threshold, alerts };
}

function loadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadSeries(path: string): DriftRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line, i) => {
    try {
      return JSON.parse(line) as DriftRecord;
    } catch {
      throw new Error(`series record ${i + 1} is not JSON`);
    }
  });
}

const USAGE = `usage: drift <command>
  run --key K --policy P --adapter A --rounds N [--series FILE] [--execute --max-requests N --max-tokens N --timeout-ms N]
  report --series FILE
  baseline --series FILE [--adapter NAME] --out FILE
  compare --series FILE --baseline FILE [--threshold 0.2]`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      key: { type: "string" }, policy: { type: "string" }, adapter: { type: "string" }, rounds: { type: "string" },
      series: { type: "string" }, baseline: { type: "string" }, threshold: { type: "string" }, out: { type: "string" },
      execute: { type: "boolean" }, "max-requests": { type: "string" }, "max-tokens": { type: "string" }, "timeout-ms": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }

  if (command === "run") {
    if (!values.key || !values.policy || !values.adapter || !values.rounds) throw new Error(`run requires --key --policy --adapter --rounds.\n${USAGE}`);
    const policy = parsePolicy(loadJson(values.policy));
    const rounds = integer(values.rounds, 1000);
    const remote = values.adapter.startsWith("openai:");
    const budget = values["max-requests"] ? requestBudget(integer(values["max-requests"]!, 30_000)) : undefined;
    const adapter = remote
      ? openai({
          model: values.adapter.slice(7), maxTokens: integer(values["max-tokens"] ?? "4096", 32_768),
          timeoutMs: integer(values["timeout-ms"] ?? "120000", 600_000), beforeRequest: budget?.beforeRequest,
        })
      : adapterByName(values.adapter);
    if (remote && !values.execute) {
      console.log(JSON.stringify({ dryRun: true, adapter: values.adapter, rounds, challengesPerSession: policy.challenges, maximumRequests: policy.challenges * rounds * 3 }, null, 2));
      return;
    }
    if (remote && (!budget || integer(values["max-requests"]!, 30_000) < policy.challenges * rounds)) throw new Error("--execute requires --max-requests at least challenges × rounds");
    const records = await runDrift({
      policy, adapter, rounds, verifierJwk: loadJson(values.key) as VerifierJwk, seriesPath: values.series,
    });
    const report = driftReport(records);
    console.error(`${adapter.name}: ${report.admitted}/${report.sessions} sessions admitted, ${report.passed}/${report.challenges} challenges passed`);
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command === "report") {
    if (!values.series) throw new Error("report requires --series");
    console.log(JSON.stringify(driftReport(loadSeries(values.series)), null, 2));
    return;
  }
  if (command === "baseline") {
    if (!values.series || !values.out) throw new Error("baseline requires --series --out");
    const records = loadSeries(values.series);
    const adapter = values.adapter ?? records[0]?.adapter ?? "unknown";
    writeFileSync(values.out, JSON.stringify(makeBaseline(records, adapter), null, 2) + "\n", { flag: "wx" });
    console.error(`baseline pinned: ${records.length} records, adapter ${adapter}`);
    return;
  }
  if (command === "compare") {
    if (!values.series || !values.baseline) throw new Error("compare requires --series --baseline");
    const threshold = values.threshold !== undefined ? Number(values.threshold) : 0.2;
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) throw new Error("--threshold must be a fraction in (0,1)");
    const result = compareDrift(driftReport(loadSeries(values.series)), loadJson(values.baseline) as DriftBaseline, threshold);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  throw new Error(`unknown command: ${command}.\n${USAGE}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "drift failed");
    process.exitCode = 2;
  }
}
