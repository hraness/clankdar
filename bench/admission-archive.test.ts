import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateVerifier } from "./attest.ts";
import { packAdmissionArchive, verifyAdmissionArchive } from "./admission-archive.ts";
import { issueSession, submitSession, type GatePolicy } from "./gate.ts";

const verifier = generateVerifier();
const policy: GatePolicy = { suite: "v2", cells: ["arithmetic:t0", "arithmetic:t1"], challenges: 2, minPass: 1, ttlSeconds: 300 };
const now = new Date("2026-09-19T00:00:00Z");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clankdar-admission-archive-"));
  const policyPath = join(root, "policy.json");
  writeFileSync(policyPath, JSON.stringify(policy));
  const admissions: string[] = [];
  for (let i = 0; i < 2; i++) {
    const issued = issueSession({ policy, verifierJwk: verifier.privateJwk, now, pick: () => i, seedBase: 800_000 + i * 100 });
    const responses = Object.fromEntries(issued.session.tickets.map((ticket) => [ticket.challenge.challengeId, ticket.expected]));
    const { admission } = submitSession({ session: issued.session, responses, verifierJwk: verifier.privateJwk, now: new Date(now.getTime() + 1_000) });
    const path = join(root, `source-${i}.json`);
    writeFileSync(path, JSON.stringify(admission));
    admissions.push(path);
  }
  const out = join(root, "archive");
  const manifest = packAdmissionArchive({
    out, id: "test-evidence", collectedAt: now.toISOString(),
    producerClaim: {
      adapter: "cli:claude:opus", requestedModel: "opus", resolvedModel: "claude-opus-5", tools: "none",
      caveat: "Signatures prove work, not model identity.",
    },
    runner: { sourceRevision: "a".repeat(40), sourceDirty: false, runtime: "bun@test", cliVersion: "test" },
    tracks: [{ name: "v2", policyPath, admissionPaths: admissions }],
  });
  return { root, out, manifest, admissions, policyPath };
}

describe("admission evidence archives", () => {
  test("packs and independently replays every signed admission", () => {
    const { out, manifest } = fixture();
    expect(manifest.verifier).toEqual({ keyId: verifier.keyId, publicKey: verifier.publicKey });
    expect(manifest.tracks[0].admissions).toHaveLength(2);
    expect(verifyAdmissionArchive(out)).toEqual({
      id: "test-evidence", verifier: { keyId: verifier.keyId, publicKey: verifier.publicKey }, sessions: 2, challenges: 4, passed: 4, admitted: 2,
      tracks: { v2: { sessions: 2, challenges: 4, passed: 4, admitted: 2 } },
    });
  });

  test("binds artifact bytes, policy, verifier, and summary", () => {
    const { out } = fixture();
    const manifestPath = join(out, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const admissionPath = join(out, manifest.tracks[0].admissions[0].file);
    writeFileSync(admissionPath, readFileSync(admissionPath, "utf8") + " ");
    expect(() => verifyAdmissionArchive(out)).toThrow("hash mismatch");

    const second = fixture();
    const secondManifestPath = join(second.out, "manifest.json");
    const changed = JSON.parse(readFileSync(secondManifestPath, "utf8"));
    changed.tracks[0].admissions[0].passed = 0;
    writeFileSync(secondManifestPath, JSON.stringify(changed));
    expect(() => verifyAdmissionArchive(second.out)).toThrow("summary mismatch");
  });

  test("rejects duplicate sessions, mixed policies, and overwrites", () => {
    const first = fixture();
    expect(() => packAdmissionArchive({
      out: first.out, id: "again", collectedAt: now.toISOString(), producerClaim: first.manifest.producerClaim,
      runner: first.manifest.runner, tracks: [{ name: "v2", policyPath: first.policyPath, admissionPaths: first.admissions }],
    })).toThrow("already exists");

    const root = mkdtempSync(join(tmpdir(), "clankdar-admission-archive-bad-"));
    const wrongPolicy = join(root, "wrong.json");
    writeFileSync(wrongPolicy, JSON.stringify({ ...policy, cells: ["strings:t1"] }));
    expect(() => packAdmissionArchive({
      out: join(root, "archive"), id: "bad-policy", collectedAt: now.toISOString(), producerClaim: first.manifest.producerClaim,
      runner: first.manifest.runner, tracks: [{ name: "v2", policyPath: wrongPolicy, admissionPaths: [first.admissions[0]] }],
    })).toThrow("policy does not match");

    const duplicate = fixture();
    const manifestPath = join(duplicate.out, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.tracks[0].admissions[1] = { ...manifest.tracks[0].admissions[0] };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyAdmissionArchive(duplicate.out)).toThrow("duplicated");
  });
});
