#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { canonical } from "./canon.ts";
import { checkAdmission, parsePolicy, type Admission, type AdmissionBody, type GatePolicy } from "./gate.ts";

export const ADMISSION_ARCHIVE_PROTOCOL = "clankdar-admission-archive-v1";
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SAFE_FILE = /^[a-z0-9][a-z0-9._/-]{0,199}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface AdmissionArchiveEntry {
  file: string;
  sha256: string;
  sessionId: string;
  verdict: boolean;
  passed: number;
  challenges: number;
}

export interface AdmissionArchiveTrack {
  name: string;
  policyFile: string;
  admissions: AdmissionArchiveEntry[];
}

export interface AdmissionArchiveManifest {
  protocol: typeof ADMISSION_ARCHIVE_PROTOCOL;
  id: string;
  collectedAt: string;
  producerClaim: {
    adapter: string;
    requestedModel: string;
    resolvedModel: string;
    tools: "none";
    caveat: string;
  };
  runner: { sourceRevision: string; sourceDirty: boolean; mergedAs?: string; runtime: string; cliVersion: string };
  verifier: { keyId: string; publicKey: string };
  tracks: AdmissionArchiveTrack[];
}

export interface AdmissionArchiveReport {
  id: string;
  verifier: AdmissionArchiveManifest["verifier"];
  sessions: number;
  challenges: number;
  passed: number;
  admitted: number;
  tracks: Record<string, { sessions: number; challenges: number; passed: number; admitted: number }>;
}

interface PackTrack { name: string; policyPath: string; admissionPaths: string[] }
interface PackOptions {
  out: string;
  id: string;
  collectedAt: string;
  producerClaim: AdmissionArchiveManifest["producerClaim"];
  runner: AdmissionArchiveManifest["runner"];
  tracks: PackTrack[];
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const readJson = (path: string, cap = 1_048_576): unknown => {
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text) > cap) throw new Error(`archive member exceeds ${cap} bytes`);
  try { return JSON.parse(text); } catch { throw new Error(`archive member is not JSON: ${basename(path)}`); }
};
const safePath = (root: string, file: string): string => {
  if (!SAFE_FILE.test(file) || file.includes("..") || file.startsWith("/")) throw new Error("archive member path is unsafe");
  const path = resolve(root, file);
  if (relative(root, path).startsWith("..")) throw new Error("archive member escapes the archive");
  return path;
};
const admissionBody = (admission: Admission): AdmissionBody => {
  try { return JSON.parse(admission.payload) as AdmissionBody; } catch { throw new Error("admission payload is not JSON"); }
};

export function packAdmissionArchive(opts: PackOptions): AdmissionArchiveManifest {
  if (!SAFE_ID.test(opts.id)) throw new Error("archive id is malformed");
  if (existsSync(opts.out)) throw new Error("archive output already exists");
  if (!opts.tracks.length || opts.tracks.length > 16) throw new Error("archive needs 1..16 tracks");
  if (!Number.isFinite(Date.parse(opts.collectedAt))) throw new Error("collectedAt is invalid");
  if (!opts.runner.sourceRevision.match(/^[0-9a-f]{40}$/)) throw new Error("sourceRevision must be a full git SHA");
  mkdirSync(opts.out, { recursive: true });
  mkdirSync(join(opts.out, "admissions"));
  mkdirSync(join(opts.out, "policies"));
  let verifier: AdmissionArchiveManifest["verifier"] | undefined;
  const names = new Set<string>();
  const tracks = opts.tracks.map((track) => {
    if (!SAFE_ID.test(track.name) || names.has(track.name)) throw new Error("track name is malformed or duplicated");
    names.add(track.name);
    if (!track.admissionPaths.length || track.admissionPaths.length > 256) throw new Error("track needs 1..256 admissions");
    const policy = parsePolicy(readJson(track.policyPath) as GatePolicy);
    const policyFile = `policies/${track.name}.json`;
    writeFileSync(join(opts.out, policyFile), json(policy), { flag: "wx" });
    const admissions = track.admissionPaths.map((path, index) => {
      const admission = readJson(path) as Admission;
      const check = checkAdmission(admission);
      if (!check.ok || check.verdict === undefined || check.passed === undefined) throw new Error(`admission does not verify: ${check.reason ?? "unknown"}`);
      const body = admissionBody(admission);
      if (canonical(body.policy) !== canonical(policy)) throw new Error("admission policy does not match its track");
      const challengeVerifier = body.challenges[0]?.verifier;
      if (!challengeVerifier) throw new Error("admission has no verifier");
      if (verifier && canonical(verifier) !== canonical(challengeVerifier)) throw new Error("archive mixes verifier keys");
      verifier = challengeVerifier;
      const file = `admissions/${track.name}-${String(index + 1).padStart(3, "0")}.json`;
      const text = json(admission);
      writeFileSync(join(opts.out, file), text, { flag: "wx" });
      return { file, sha256: sha256(text), sessionId: body.sessionId, verdict: check.verdict, passed: check.passed, challenges: body.challenges.length };
    });
    return { name: track.name, policyFile, admissions };
  });
  if (!verifier) throw new Error("archive has no verifier");
  const manifest: AdmissionArchiveManifest = {
    protocol: ADMISSION_ARCHIVE_PROTOCOL,
    id: opts.id,
    collectedAt: new Date(opts.collectedAt).toISOString(),
    producerClaim: opts.producerClaim,
    runner: opts.runner,
    verifier,
    tracks,
  };
  writeFileSync(join(opts.out, "manifest.json"), json(manifest), { flag: "wx" });
  verifyAdmissionArchive(opts.out);
  return manifest;
}

export function verifyAdmissionArchive(dir: string): AdmissionArchiveReport {
  const value = readJson(join(dir, "manifest.json"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("archive manifest is malformed");
  const manifest = value as AdmissionArchiveManifest;
  if (manifest.protocol !== ADMISSION_ARCHIVE_PROTOCOL || !SAFE_ID.test(manifest.id)) throw new Error("archive manifest protocol or id is invalid");
  if (!Number.isFinite(Date.parse(manifest.collectedAt))) throw new Error("archive collectedAt is invalid");
  if (!manifest.verifier || typeof manifest.verifier.keyId !== "string" || typeof manifest.verifier.publicKey !== "string") throw new Error("archive verifier is malformed");
  if (!manifest.producerClaim || manifest.producerClaim.tools !== "none" || ![manifest.producerClaim.adapter, manifest.producerClaim.requestedModel, manifest.producerClaim.resolvedModel, manifest.producerClaim.caveat].every((field) => typeof field === "string" && field.length > 0 && field.length <= 500)) throw new Error("archive producer claim is malformed");
  if (!manifest.runner || !/^[0-9a-f]{40}$/.test(manifest.runner.sourceRevision) || typeof manifest.runner.sourceDirty !== "boolean" || (manifest.runner.mergedAs !== undefined && !/^[0-9a-f]{40}$/.test(manifest.runner.mergedAs)) || typeof manifest.runner.runtime !== "string" || typeof manifest.runner.cliVersion !== "string") throw new Error("archive runner is malformed");
  if (!Array.isArray(manifest.tracks) || !manifest.tracks.length || manifest.tracks.length > 16) throw new Error("archive tracks are malformed");
  const names = new Set<string>();
  const sessions = new Set<string>();
  const tracks: AdmissionArchiveReport["tracks"] = {};
  let totalChallenges = 0, totalPassed = 0, totalAdmitted = 0;
  for (const track of manifest.tracks) {
    if (!SAFE_ID.test(track.name) || names.has(track.name)) throw new Error("archive track name is malformed or duplicated");
    names.add(track.name);
    const policy = parsePolicy(readJson(safePath(dir, track.policyFile)) as GatePolicy);
    if (!Array.isArray(track.admissions) || !track.admissions.length || track.admissions.length > 256) throw new Error("archive admissions are malformed");
    let challenges = 0, passed = 0, admitted = 0;
    for (const entry of track.admissions) {
      if (!entry || typeof entry !== "object" || !HEX64.test(entry.sha256)) throw new Error("archive admission entry is malformed");
      const path = safePath(dir, entry.file);
      const text = readFileSync(path, "utf8");
      if (sha256(text) !== entry.sha256) throw new Error(`archive admission hash mismatch: ${entry.file}`);
      const admission = JSON.parse(text) as Admission;
      const check = checkAdmission(admission);
      if (!check.ok || check.verdict === undefined || check.passed === undefined) throw new Error(`archive admission does not verify: ${entry.file}`);
      const body = admissionBody(admission);
      if (canonical(body.policy) !== canonical(policy)) throw new Error(`archive admission policy mismatch: ${entry.file}`);
      if (canonical(body.challenges[0]?.verifier) !== canonical(manifest.verifier)) throw new Error(`archive verifier mismatch: ${entry.file}`);
      if (sessions.has(body.sessionId) || body.sessionId !== entry.sessionId) throw new Error("archive session is duplicated or mismatched");
      sessions.add(body.sessionId);
      if (entry.verdict !== check.verdict || entry.passed !== check.passed || entry.challenges !== body.challenges.length) throw new Error(`archive summary mismatch: ${entry.file}`);
      challenges += body.challenges.length;
      passed += check.passed;
      admitted += Number(check.verdict);
    }
    tracks[track.name] = { sessions: track.admissions.length, challenges, passed, admitted };
    totalChallenges += challenges;
    totalPassed += passed;
    totalAdmitted += admitted;
  }
  return { id: manifest.id, verifier: manifest.verifier, sessions: sessions.size, challenges: totalChallenges, passed: totalPassed, admitted: totalAdmitted, tracks };
}

const USAGE = `usage: admission-archive <command>
  verify DIR
  pack --out DIR --id ID --collected-at ISO --adapter A --requested-model M --resolved-model M --cli-version V --source SHA [--source-dirty] [--merged-as SHA] --track name:policy.json:admission.json[,admission.json...]`;

export function main(args = process.argv.slice(2)): void {
  const [command, ...rest] = args;
  const { values, positionals } = parseArgs({ args: rest, options: {
    out: { type: "string" }, id: { type: "string" }, "collected-at": { type: "string" }, adapter: { type: "string" },
    "requested-model": { type: "string" }, "resolved-model": { type: "string" }, "cli-version": { type: "string" },
    source: { type: "string" }, "source-dirty": { type: "boolean" }, "merged-as": { type: "string" }, track: { type: "string", multiple: true }, help: { type: "boolean", short: "h" },
  }, allowPositionals: true, strict: true });
  if (values.help || !command) { console.log(USAGE); return; }
  if (command === "verify") {
    if (!positionals[0]) throw new Error(`verify requires DIR\n${USAGE}`);
    console.log(JSON.stringify(verifyAdmissionArchive(positionals[0]), null, 2));
    return;
  }
  if (command === "pack") {
    const required = [values.out, values.id, values["collected-at"], values.adapter, values["requested-model"], values["resolved-model"], values["cli-version"], values.source];
    if (required.some((v) => v === undefined) || !values.track?.length) throw new Error(`pack requires more options\n${USAGE}`);
    const tracks = values.track.map((spec) => {
      const [name, policyPath, admissionList] = spec.split(":", 3);
      if (!name || !policyPath || !admissionList) throw new Error("--track expects name:policy.json:admission.json[,admission.json...]");
      return { name, policyPath, admissionPaths: admissionList.split(",") };
    });
    const manifest = packAdmissionArchive({
      out: values.out!, id: values.id!, collectedAt: values["collected-at"]!, tracks,
      producerClaim: {
        adapter: values.adapter!, requestedModel: values["requested-model"]!, resolvedModel: values["resolved-model"]!, tools: "none",
        caveat: "The issuer reports the adapter and model provenance. Signatures prove the recorded work and score, not model identity or exclusive authorship.",
      },
      runner: { sourceRevision: values.source!, sourceDirty: values["source-dirty"] ?? false, ...(values["merged-as"] ? { mergedAs: values["merged-as"] } : {}), runtime: `bun@${Bun.version}`, cliVersion: values["cli-version"]! },
    });
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  throw new Error(`unknown command: ${command}\n${USAGE}`);
}

if (import.meta.main) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "admission archive failed"); process.exitCode = 2; }
}
