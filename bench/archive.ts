import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildReport, readRuns } from "./report.ts";
import { replayRun } from "./replay.ts";
import { AGENT_SUITE_VERSION } from "../ladder/mod.ts";
import { AGENT_PROTOCOL_VERSION } from "./adapters.ts";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

/** Track-appropriate limitations when the caller does not supply --limits. */
const DEFAULT_LIMITATIONS: Record<string, string[]> = {
  unaided: [
    "Twenty public seeds per family/tier is an exploratory sample, not a certification threshold.",
    "Requested gateway aliases and provider-reported resolved model labels are not independent model attestations.",
    "Tier aggregates are not a scalar capability ladder because tiers contain different puzzle families; compare family/tier cells and model profiles.",
    "Public generators can be memorized or solved with tools. This run used one-turn, no-tool model calls and does not prove identity, trust, personhood, or safe authority.",
  ],
  "tool-agent": [
    "Twenty public seeds per family/tier is an exploratory sample, not a certification threshold.",
    "Requested gateway aliases and provider-reported resolved model labels are not independent model attestations.",
    "This track measures bounded tool use under the recorded call and turn budgets; scores are not comparable to unaided suites and do not estimate base-model capability.",
    "Tool environments are deterministic closures over generated data; this run does not exercise or certify access to shells, networks, filesystems, secrets, or any other real capability.",
    "Transcripts replay bit-for-bit against regenerated environments; a failed or absent transcript is a protocol or provider outcome, not a wrong answer.",
    "Passing a tool-agent cell does not prove identity, trust, personhood, or safe authority.",
  ],
};

export function publishCalibration(source: string, target: string, id: string, limitations?: string[]): void {
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
  const track = manifests[0].suiteVersion === AGENT_SUITE_VERSION ? "tool-agent" : "unaided";
  const manifest = {
    schemaVersion: 1,
    id,
    track,
    status: "exploratory held-out calibration; not a capability certification",
    collectedOn: String(manifests[0].startedAt).slice(0, 10),
    suiteVersion: manifests[0].suiteVersion,
    scorerVersion: manifests[0].scorerVersion,
    suiteHash: manifests[0].suiteHash,
    seeds: replayed.seeds,
    cells: replayed.cells,
    models: replayed.models.map((model) => model.model),
    protocol: manifests.map((entry) => ({ adapter: entry.adapter, config: entry.config, concurrency: entry.concurrency, timeoutMs: entry.timeoutMs, runtime: entry.runtime, source: entry.source, ...(entry.protocol ? { episodeProtocol: entry.protocol } : {}) })),
    scoring: { strict: "family-aware canonical whole-response match", diagnostic: "independent final-block extraction followed by exact match", errors: "separate from wrong answers and excluded from valid-response denominators" },
    limitations: limitations ?? DEFAULT_LIMITATIONS[track],
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
  // Tool-agent archives additionally replay every recorded transcript against
  // regenerated deterministic environments.
  const agentic = manifest.track === "tool-agent" || manifest.protocol?.some?.((entry: { episodeProtocol?: string }) => entry.episodeProtocol === AGENT_PROTOCOL_VERSION);
  if (agentic) {
    for (const artifact of manifest.artifacts.filter((a: { file: string }) => a.file.endsWith(".jsonl.gz"))) {
      for (const outcome of replayRun(join(dir, artifact.file))) {
        if (!outcome.replayed && !outcome.reason?.startsWith("episode error")) throw new Error(`transcript replay failed: ${artifact.file} ${outcome.row} ${outcome.reason ?? ""}`);
      }
    }
  }
  return report;
}

if (import.meta.main) {
  const [command, source, target, id, ...rest] = process.argv.slice(2);
  if (command === "publish" && source && target && id) {
    const limitsIndex = rest.indexOf("--limits");
    const limitations = limitsIndex >= 0 ? JSON.parse(readFileSync(rest[limitsIndex + 1], "utf8")) : undefined;
    if (limitations !== undefined && (!Array.isArray(limitations) || limitations.some((l) => typeof l !== "string"))) throw new Error("--limits must be a JSON string array");
    publishCalibration(source, target, id, limitations); verifyCalibration(target); console.log(`Verified calibration archive: ${target}`);
  }
  else if (command === "verify" && source && !target) { verifyCalibration(source); console.log("Calibration archive hashes and scores verified"); }
  else throw new Error("usage: bun bench/archive.ts publish SOURCE NEW-DIRECTORY ID | verify DIRECTORY");
}
