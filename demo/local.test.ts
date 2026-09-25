import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runLocalCheck, saveLocalCheck, solveAlgalChallenges } from "./local.ts";
import { moduleSolver } from "./cli.ts";
import { verifyReceipt } from "../cloudflare/examples/verify-receipt.mjs";
import { canonical } from "../cloudflare/src/protocol.ts";

const temporary = () => mkdtempSync(join(tmpdir(), "clankdar-try-test-"));
const pins = (result: Awaited<ReturnType<typeof runLocalCheck>>) => ({ issuerPublicKey: result.issuerPublicKey, sessionId: result.id, context: result.context, sha256: result.sha256 });
async function cli(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "cli.ts"), ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

describe("local first-use demonstration", () => {
  test("fresh offline checks use the hosted ALGAL policy and independently replay exact canonical receipts", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(() => { throw new Error("network forbidden in local demo"); }, { preconnect: originalFetch.preconnect }) as typeof fetch;
    try {
      const [first, second] = await Promise.all([runLocalCheck(), runLocalCheck()]);
      expect(first.id).not.toBe(second.id);
      expect(first.issuerPublicKey).not.toBe(second.issuerPublicKey);
      expect(first.sha256).not.toBe(second.sha256);
      expect(first.solver).toBe("scripted");
      expect(first.verified).toMatchObject({ ok: true, pass: true, passed: 4, required: 3, policy: { suite: "algal", challenges: 4, minPass: 3, ttlSeconds: 180 } });
      expect(first.receiptText).toBe(canonical(JSON.parse(first.receiptText)));
      expect(JSON.parse(first.receiptText).protocol).toBe("clankdar-gate-v1");
      expect(verifyReceipt(first.receiptText, pins(first)).ok).toBe(true);
      expect(verifyReceipt(first.receiptText, { ...pins(first), issuerPublicKey: second.issuerPublicKey }).ok).toBe(false);
      expect(verifyReceipt(first.receiptText, { ...pins(first), sessionId: second.id }).ok).toBe(false);
      expect(verifyReceipt(first.receiptText, { ...pins(first), context: "another request" }).ok).toBe(false);
      expect(verifyReceipt(first.receiptText + " ", pins(first)).ok).toBe(false);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("custom solvers receive public clones only and a failed score still has a valid signed receipt", async () => {
    const result = await runLocalCheck({ solve: (challenges, signal) => {
      expect(signal.aborted).toBe(false);
      expect(challenges).toHaveLength(4);
      for (const challenge of challenges) {
        expect(Object.keys(challenge).sort()).toEqual(["challengeId", "context", "expiresAt", "family", "kind", "nonce", "prompt", "protocol", "seedCommit", "sessionId", "suiteVersion", "tier", "verifier"]);
        expect(challenge.suiteVersion).toBe("clankdar-algal-v1");
      }
      const answers = solveAlgalChallenges(challenges, signal) as Record<string, string>;
      // Mutation must never alter the verifier's private ticket or signed prompt.
      challenges[0].prompt = "tampered by solver";
      return Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, (BigInt(answer) + 1n).toString()]));
    } });
    expect(result.solver).toBe("custom");
    expect(result.verified).toMatchObject({ ok: true, pass: false, passed: 0, required: 3 });
    expect(result.receiptText).not.toContain("tampered by solver");
  });

  test("invalid, failed and cancelled callbacks produce bounded errors without source payloads", async () => {
    await expect(runLocalCheck({ solve: () => ({ foreign: "1" }) })).rejects.toThrow("mapping challenge IDs");
    await expect(runLocalCheck({ solve: () => { throw new Error("SECRET_PROVIDER_BODY"); } })).rejects.toThrow("solver failed; check your local solver module");
    const controller = new AbortController();
    await expect(runLocalCheck({ signal: controller.signal, solve: (_, signal) => {
      setTimeout(() => controller.abort(), 5);
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("SECRET_PROVIDER_BODY")), { once: true }));
    } })).rejects.toThrow("deadline or was cancelled");
  });

  test("saving creates separate directories containing raw receipts and public pins only", async () => {
    const directory = temporary();
    try {
      const result = await runLocalCheck();
      const first = saveLocalCheck(result, directory);
      const second = saveLocalCheck(result, directory);
      expect(first.receiptPath).not.toBe(second.receiptPath);
      expect(readFileSync(first.receiptPath, "utf8")).toBe(result.receiptText);
      expect(verifyReceipt(readFileSync(first.receiptPath), pins(result)).ok).toBe(true);
      expect(JSON.parse(readFileSync(first.verificationPath, "utf8"))).toEqual({ provenance: "local-demo", solver: "scripted", ...pins(result) });
      expect(readdirSync(resolve(first.receiptPath, "..")).sort()).toEqual(["receipt.json", "verification.json"]);
      expect(() => saveLocalCheck({ ...result, receiptText: result.receiptText + " " }, directory)).toThrow("unverified receipt");
      expect(readdirSync(directory)).toHaveLength(2);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("the module adapter terminates stalled custom code and suppresses thrown payloads", async () => {
    const directory = temporary();
    try {
      const stalled = join(directory, "stalled.ts");
      writeFileSync(stalled, "export function solve() { for (;;) {} }\n");
      const controller = new AbortController();
      const stop = setTimeout(() => controller.abort(), 80);
      try { await expect(runLocalCheck({ solve: moduleSolver(stalled), signal: controller.signal })).rejects.toThrow("deadline or was cancelled"); }
      finally { clearTimeout(stop); }
      const broken = join(directory, "broken.ts");
      writeFileSync(broken, 'console.error("SECRET_SOURCE_LOG"); throw new Error("SECRET_SOURCE_BODY");\n');
      const result = await cli(directory, "--solver", broken);
      expect(result.code).toBe(2);
      expect(result.stdout + result.stderr).not.toContain("SECRET_");
      expect(result.stderr).toContain("solver failed");
      expect(readdirSync(directory).sort()).toEqual(["broken.ts", "stalled.ts"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("the one-command CLI runs and a caller-selected solver has the same callback contract", async () => {
    const directory = temporary();
    try {
      const first = await cli(directory);
      expect(first.code, first.stderr).toBe(0);
      expect(first.stdout).toContain("PASS · 4/4");
      expect(first.stdout).toContain("This is not a model score or hosted attestation");
      expect(first.stdout).toContain("--issuer ");
      const custom = join(directory, "my-solver.ts");
      writeFileSync(custom, `import {solveAlgalChallenges} from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "local.ts")).href)};\nexport const solve = solveAlgalChallenges;\n`);
      const second = await cli(directory, "--solver", custom);
      expect(second.code, second.stderr).toBe(0);
      expect(second.stdout).toContain("with your solver");
      expect(second.stdout).toContain("PASS · 4/4");
      const failed = join(directory, "failed.ts");
      writeFileSync(failed, 'export function solve() { return {}; }\n');
      const negative = await cli(directory, "--solver", failed);
      expect(negative.code, negative.stderr).toBe(1);
      expect(negative.stdout).toContain("FAIL · 0/4");
      expect(negative.stdout).toContain("signature and scores independently verified");
      expect(readdirSync(join(directory, "results"))).toHaveLength(3);
      const invalid = await cli(directory, "--unrecognized");
      expect(invalid.code).toBe(2);
      expect(readdirSync(join(directory, "results"))).toHaveLength(3);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
