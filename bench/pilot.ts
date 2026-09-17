import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { buildReport, readRuns, rowKey, type CalibrationReport, type RecordedRow } from "./report.ts";

export const PILOT_EXCLUSIONS = {
  gridpath: "Legacy generation guaranteed a ten-move monotone path, so a constant-answer baseline solves the family.",
  sequence: "Legacy prompts did not constrain the recurrence class; the geometric branch also showed only four terms.",
  hiddenfn: "Legacy prompts did not state a finite hypothesis class or establish a unique query answer within it.",
  gridxf: "Legacy prompts did not state a finite transform grammar or disambiguate all query predictions.",
};

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export function publicPilotRow(row: RecordedRow): RecordedRow {
  return {
    adapter: row.adapter, family: row.family, tier: row.tier, seed: row.seed,
    prompt: row.prompt, expected: row.expected, response: row.response, pass: row.pass, latencyMs: row.latencyMs,
    ...(row.error ? { error: "provider_error" } : {}),
  };
}

export function publishPilot(source: string, target: string): void {
  const runs = readRuns(source);
  const original = buildReport(runs, Object.keys(PILOT_EXCLUSIONS));
  if (original.provenance !== "legacy" || runs.length !== 12 || runs.some((run) => run.rows.length !== 250) || JSON.stringify(original.seeds) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) throw new Error("expected the complete twelve-model, ten-seed legacy pilot");
  const archives = runs.map((run) => {
    const rows = [...run.rows].sort((a, b) => rowKey(a).localeCompare(rowKey(b), "en")).map(publicPilotRow);
    const summary = { type: "summary", adapter: run.model, total: rows.length, passed: rows.filter((row) => row.pass).length, errors: rows.filter((row) => row.error).length };
    const bytes = gzipSync([...rows, summary].map((row) => JSON.stringify(row)).join("\n") + "\n", { level: 9 });
    return { file: run.source.file.replace(/\.gz$/, "") + ".gz", bytes };
  });
  mkdirSync(target, { mode: 0o755 });
  for (const { file, bytes } of archives) writeFileSync(join(target, file), bytes, { flag: "wx" });
  const report = buildReport(readRuns(target), Object.keys(PILOT_EXCLUSIONS));
  const reportBytes = JSON.stringify(report, null, 2) + "\n";
  writeFileSync(join(target, "report.json"), reportBytes, { flag: "wx" });
  const manifest = {
    schemaVersion: 1, id: "pilot-v0", status: "exploratory; not a capability certification", collectedOn: "2026-09-17",
    generatorBaseRevision: "d49410b98e4cfb48d579fa7c71139b46267de7dc",
    driverRecordedAfterRunAt: "e5df6847fe2109e9cadeba9a6100e82d8524d589",
    provenanceLimit: "The exact dirty run tree, provider-resolved model versions, finish reasons, effective negotiated parameters, and per-request usage were not recorded. Model names are requested gateway aliases, not attestations.",
    protocol: { endpoint: "https://ai-gateway.vercel.sh/v1", turns: 1, tools: false, requestedTemperature: 0, requestedMaxTokens: 4096, timeoutMs: 120000, concurrency: 8 },
    scoring: { version: report.scorerVersion, strict: "family-aware canonical whole-response match", diagnostic: "independent final-block extraction followed by exact match; not a capability estimate", errors: "separate from wrong answers; excluded from valid-response denominators" },
    exclusions: PILOT_EXCLUSIONS, excludedInstancesPerModel: 60, screenedInstancesPerModel: 190,
    originalSources: runs.map((run) => run.source),
    privacy: "Only synthetic prompts, expected answers, model replies, verdicts, latency, and model labels are retained. Upstream error bodies and unknown fields are omitted. The private source files are unchanged.",
    limitations: [
      "Ten seeds per family/tier is a small exploratory sample. Wilson intervals are descriptive binomial intervals, not a tier certification.",
      "Public seeds and published generators can be memorized or solved programmatically. The benchmark does not prove model identity, personhood, trust, or tool authority.",
      "The screened subset removes design-invalid or degenerate families uniformly across models. Full legacy-suite scores remain in report.json for transparency.",
      "This is the legacy pilot rescored under the corrected scorer, not a model run against clankdar-suite-v2. New-suite calibration is still required.",
      "The final-block diagnostic is a formatting diagnostic only; it can miss correctly expressed answers and does not establish how an answer was obtained.",
    ],
    artifacts: [...archives.map(({ file, bytes }) => ({ file, sha256: sha256(bytes), bytes: bytes.length })), { file: "report.json", sha256: sha256(reportBytes), bytes: Buffer.byteLength(reportBytes) }],
  };
  writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
}

export function verifyPilot(dir: string): CalibrationReport {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.id !== "pilot-v0" || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 13) throw new Error("invalid pilot manifest");
  for (const artifact of manifest.artifacts) {
    if (typeof artifact.file !== "string" || basename(artifact.file) !== artifact.file || !/^(?:[a-z0-9_.-]+\.jsonl\.gz|report\.json)$/.test(artifact.file)) throw new Error("invalid pilot artifact path");
    const bytes = readFileSync(join(dir, artifact.file));
    if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error(`pilot integrity mismatch: ${artifact.file}`);
  }
  const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  const replayed = buildReport(readRuns(dir), Object.keys(PILOT_EXCLUSIONS));
  if (JSON.stringify(replayed) !== JSON.stringify(report) || replayed.models.length !== 12 || replayed.models.some((model) => model.all.total !== 250 || model.eligible.total !== 190)) throw new Error("pilot report cannot be reproduced from its archived replies");
  return replayed;
}

if (import.meta.main) {
  const [command, source, target] = process.argv.slice(2);
  if (command === "publish" && source && target) { publishPilot(source, target); verifyPilot(target); console.log(`Verified pilot archive: ${target}`); }
  else if (command === "verify" && source && !target) { verifyPilot(source); console.log("Pilot archive hashes and all scores verified"); }
  else throw new Error("usage: bun bench/pilot.ts publish SOURCE NEW-DIRECTORY | verify DIRECTORY");
}
