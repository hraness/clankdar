import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonical, checkReceipt, generateVerifier, issueChallenge, signBody, verifyResponse, type ReceiptBody } from "./attest.ts";
import { checkAdmission, issueSession, parsePolicy, submitSession, type GatePolicy } from "./gate.ts";
import { generatePool, parsePool } from "./holdout.ts";
import { buildReport, parseRun } from "./report.ts";

const now = new Date("2026-09-19T12:00:00Z");
const answeredAt = new Date("2026-09-19T12:00:01Z");
const verifier = generateVerifier();
const policy: GatePolicy = { suite: "algal", cells: ["algal:t1", "algal:t2", "algal:t3"], challenges: 2, minPass: 2, ttlSeconds: 120 };

async function cli(file: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, file), ...args], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

describe("Algal benchmark and portable evidence", () => {
  test("the local oracle records all three tiers under their own version and reports replayable counts", async () => {
    const result = await cli("cli.ts", "--suite", "algal", "--adapter", "oracle", "--seeds", "17-18");
    expect(result.code, result.stderr).toBe(0);
    const run = parseRun(result.stdout);
    expect(run.manifest?.suiteVersion).toBe("clankdar-algal-v1");
    expect(run.manifest?.protocol).toBeUndefined();
    expect(run.rows).toHaveLength(6);
    expect(new Set(run.rows.map((row) => row.family))).toEqual(new Set(["algal"]));
    const report = buildReport([run]);
    expect(report.models[0].eligible).toMatchObject({ n: 6, passed: 6, errors: 0, strict: 1 });
    expect(report.cells).toEqual(["algal:t1", "algal:t2", "algal:t3"]);
    expect(buildReport([run], ["algal"]).models[0].eligible.n).toBe(0);
    const dryRun = await cli("cli.ts", "--suite", "algal", "--adapter", "openai:unused-test-model", "--seeds", "17");
    expect(dryRun.code, dryRun.stderr).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({ dryRun: true, suiteVersion: "clankdar-algal-v1", instances: 3 });
  });

  test("the generator oracle supports the frozen version and the worked example runs without a provider", async () => {
    const named = await cli("instance.ts", "--suite", "algal", "--family", "algal", "--tier", "2", "--seed", "17");
    const versioned = await cli("instance.ts", "--suite-version", "clankdar-algal-v1", "--family", "algal", "--tier", "2", "--seed", "17");
    expect(named.code, named.stderr).toBe(0);
    expect(versioned.code, versioned.stderr).toBe(0);
    expect(JSON.parse(named.stdout)).toEqual(JSON.parse(versioned.stdout));
    const example = await cli("algal-example.ts");
    expect(example.code, example.stderr).toBe(0);
    const worked = JSON.parse(example.stdout);
    expect(String(worked.answer)).toBe("34");
    expect(worked.expr).toBeDefined();
    expect(worked.inputs).toEqual({ values: [1, 3, 2, 5] });
  });

  test("all tiers replay positive and negative receipts and reject re-signed fabricated work", () => {
    for (const tier of [1, 2, 3]) {
      const { ticket } = issueChallenge({ suite: "algal", family: "algal", tier, seed: 17, verifierJwk: verifier.privateJwk, now });
      const receipt = verifyResponse({ ticket, response: ticket.expected, verifierJwk: verifier.privateJwk, now: answeredAt });
      expect(checkReceipt(receipt)).toEqual({ ok: true, verdict: true });
      const incorrect = (BigInt(ticket.expected) + 1n).toString();
      const failed = verifyResponse({ ticket, response: incorrect, verifierJwk: verifier.privateJwk, now: answeredAt });
      expect(checkReceipt(failed)).toEqual({ ok: true, verdict: false });
      for (const change of ["prompt", "answer"] as const) {
        const forged = JSON.parse(receipt.payload) as ReceiptBody;
        if (change === "prompt") forged.challenge.prompt += " altered";
        else { forged.expected = incorrect; forged.response = incorrect; }
        expect(checkReceipt({ ...receipt, payload: canonical(forged), signature: signBody(forged, verifier.privateJwk) }).ok).toBe(false);
      }
    }
  });

  test("gate admissions replay and the offline example enforces the pinned issuer", async () => {
    expect(parsePolicy(policy)).toEqual(policy);
    expect(() => parsePolicy({ ...policy, suite: "v2" })).toThrow("unknown cell");
    const issued = issueSession({ policy, verifierJwk: verifier.privateJwk, now, context: "algal-test", seedBase: 17, pick: () => 1 });
    const responses = Object.fromEntries(issued.session.tickets.map((ticket) => [ticket.challenge.challengeId, ticket.expected]));
    const { admission } = submitSession({ session: issued.session, responses, verifierJwk: verifier.privateJwk, now: answeredAt });
    expect(checkAdmission(admission)).toEqual({ ok: true, verdict: true, passed: 2 });
    const dir = mkdtempSync(join(tmpdir(), "clankdar-algal-"));
    try {
      const file = join(dir, "receipt.json");
      writeFileSync(file, canonical(admission));
      const valid = await cli("../cloudflare/examples/verify-receipt.mjs", file, "--issuer", verifier.publicKey, "--context", "algal-test", "--session", issued.session.sessionId);
      expect(valid.code, valid.stderr).toBe(0);
      expect(JSON.parse(valid.stdout)).toMatchObject({ ok: true, pass: true, passed: 2, required: 2, policy });
      const foreign = await cli("../cloudflare/examples/verify-receipt.mjs", file, "--issuer", generateVerifier().publicKey);
      expect(foreign.code).not.toBe(0);
      expect(JSON.parse(foreign.stdout).ok).toBe(false);
    } finally { rmSync(dir, { recursive: true }); }
  });

  test("existing held-out semantics also preserve the Algal suite binding", () => {
    const pool = parsePool(generatePool({ suite: "algal", cells: ["algal:t1"] }));
    const { ticket } = issueChallenge({ suite: "algal", family: "algal", tier: 1, seed: 17, holdoutPool: pool, verifierJwk: verifier.privateJwk, now });
    const receipt = verifyResponse({ ticket, response: ticket.expected, pool, verifierJwk: verifier.privateJwk, now: answeredAt });
    expect(checkReceipt(receipt)).toEqual({ ok: true, verdict: true, replayable: false });
    expect(checkReceipt(receipt, { pool })).toEqual({ ok: true, verdict: true });
  });
});
