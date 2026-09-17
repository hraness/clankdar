import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseInts } from "./options.ts";
import { wilson } from "./stats.ts";

async function cli(...args: string[]) {
  const process = Bun.spawn([Bun.which("bun")!, resolve(import.meta.dir, "cli.ts"), ...args], { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { code, stdout, stderr };
}

describe("CLI and run artifacts", () => {
  test("stdout is JSONL with a manifest, one row per instance, and summary", async () => {
    const result = await cli("--adapter", "oracle", "--families", "echo", "--seeds", "1-2");
    expect(result.code).toBe(0);
    const rows = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.type)).toEqual(["run", "result", "result", "summary"]);
    expect(new Set(rows.map((row) => row.runId)).size).toBe(1);
    expect(rows.at(-1).passed).toBe(2);
    expect(rows.at(-1).byCell["echo:t0"].n).toBe(2);
    expect(rows.at(-1).bySeed["1"].n).toBe(1);
  });

  test("existing evidence cannot be truncated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-cli-"));
    const out = join(dir, "existing.jsonl");
    try {
      writeFileSync(out, "preserve this evidence\n");
      const result = await cli("--adapter", "oracle", "--families", "echo", "--seeds", "1", "--out", out);
      expect(result.code).not.toBe(0);
      expect(readFileSync(out, "utf8")).toBe("preserve this evidence\n");
    } finally { rmSync(dir, { recursive: true }); }
  });

  test("model invocations default to a no-network dry run", async () => {
    const result = await cli("--adapter", "openai:test-model", "--families", "echo", "--seeds", "1");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).dryRun).toBe(true);
    const refused = await cli("--adapter", "openai:test-model", "--families", "echo", "--seeds", "1", "--execute");
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("--max-requests");
  });

  test("unknown flags and malformed selections fail", async () => {
    for (const args of [["--wat"], ["--adapter", "oracle", "--concurrency", "0"], ["--adapter", "oracle", "--seeds", "2-1"], ["--adapter", "oracle", "--families", "typo"]]) {
      expect((await cli(...args)).code).not.toBe(0);
    }
    expect((await cli("--help")).code).toBe(0);
  });
});

test("seed parser is bounded and rejects duplicates", () => {
  expect(parseInts("3,1-2")).toEqual([1, 2, 3]);
  for (const spec of ["", "-1", "1.5", "NaN", "1,1", "1-3,2", "4-2", "1-10000000000", "4294967296"]) expect(() => parseInts(spec)).toThrow();
});

test("Wilson intervals do not mistake ten perfect samples for a certified 90% floor", () => {
  const interval = wilson(10, 10)!;
  expect(interval[0]).toBeCloseTo(0.722467, 5);
  expect(interval[1]).toBeCloseTo(1, 10);
  expect(wilson(0, 0)).toBeNull();
  expect(wilson(0, 10)![1]).toBeCloseTo(0.277533, 5);
  expect(() => wilson(11, 10)).toThrow();
});
