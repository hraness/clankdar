import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildReport, readRuns } from "./report.ts";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

export function publishCalibration(source: string, target: string, id: string): void {
  if (!/^v[0-9a-z.-]+$/.test(id)) throw new Error("invalid calibration ID");
  const runs = readRuns(source);
  const report = buildReport(runs);
  if (report.provenance !== "versioned") throw new Error("calibration requires versioned runs");
  mkdirSync(target, { mode: 0o755 });
  const artifacts = runs.map((run) => {
    const input = readFileSync(join(source, run.source.file));
    const file = run.source.file.replace(/\.gz$/, "") + ".gz";
    const bytes = run.source.file.endsWith(".gz") ? input : gzipSync(input, { level: 9 });
    writeFileSync(join(target, file), bytes, { flag: "wx" });
    return { file, sha256: sha256(bytes), bytes: bytes.length };
  });
  const replayed = buildReport(readRuns(target));
  const reportBytes = JSON.stringify(replayed, null, 2) + "\n";
  writeFileSync(join(target, "report.json"), reportBytes, { flag: "wx" });
  artifacts.push({ file: "report.json", sha256: sha256(reportBytes), bytes: Buffer.byteLength(reportBytes) });
  const manifests = runs.map((run) => run.manifest!);
  const manifest = {
    schemaVersion: 1,
    id,
    status: "exploratory held-out calibration; not a capability certification",
    collectedOn: String(manifests[0].startedAt).slice(0, 10),
    suiteVersion: manifests[0].suiteVersion,
    scorerVersion: manifests[0].scorerVersion,
    suiteHash: manifests[0].suiteHash,
    seeds: replayed.seeds,
    cells: replayed.cells,
    models: replayed.models.map((model) => model.model),
    protocol: manifests.map((entry) => ({ adapter: entry.adapter, config: entry.config, concurrency: entry.concurrency, timeoutMs: entry.timeoutMs, runtime: entry.runtime, source: entry.source })),
    scoring: { strict: "family-aware canonical whole-response match", diagnostic: "independent final-block extraction followed by exact match", errors: "separate from wrong answers and excluded from valid-response denominators" },
    limitations: [
      "Twenty public seeds per family/tier is an exploratory sample, not a certification threshold.",
      "Requested gateway aliases and provider-reported resolved model labels are not independent model attestations.",
      "The source manifests record a dirty tree because the held-out seed exposed a bounded-search defect before calls; the archived prompts, answers, authoritative suite hash, and subsequent patch preserve exact replayability.",
      "Tier aggregates are not a scalar capability ladder because tiers contain different puzzle families; compare family/tier cells and model profiles.",
      "Public generators can be memorized or solved with tools. This run used one-turn, no-tool model calls and does not prove identity, trust, personhood, or safe authority.",
    ],
    artifacts,
  };
  writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
}

export function verifyCalibration(dir: string): ReturnType<typeof buildReport> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts) || manifest.artifacts.length < 2) throw new Error("invalid calibration manifest");
  for (const artifact of manifest.artifacts) {
    if (typeof artifact.file !== "string" || basename(artifact.file) !== artifact.file || !/^(?:[a-z0-9_.-]+\.jsonl\.gz|report\.json)$/.test(artifact.file)) throw new Error("invalid calibration artifact path");
    const bytes = readFileSync(join(dir, artifact.file));
    if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error(`calibration integrity mismatch: ${artifact.file}`);
  }
  const report = buildReport(readRuns(dir));
  const recorded = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  if (report.suiteHash !== manifest.suiteHash || JSON.stringify(report.seeds) !== JSON.stringify(manifest.seeds) || JSON.stringify(report.cells) !== JSON.stringify(manifest.cells) || JSON.stringify(report) !== JSON.stringify(recorded)) throw new Error("calibration report cannot be reproduced");
  return report;
}

if (import.meta.main) {
  const [command, source, target, id] = process.argv.slice(2);
  if (command === "publish" && source && target && id) { publishCalibration(source, target, id); verifyCalibration(target); console.log(`Verified calibration archive: ${target}`); }
  else if (command === "verify" && source && !target) { verifyCalibration(source); console.log("Calibration archive hashes and scores verified"); }
  else throw new Error("usage: bun bench/archive.ts publish SOURCE NEW-DIRECTORY ID | verify DIRECTORY");
}
