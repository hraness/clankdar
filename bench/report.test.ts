import { describe, expect, test } from "bun:test";
import { buildReport, parseRun } from "./report.ts";
import { recordRun } from "./record.ts";
import { oracle } from "./adapters.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const row = { adapter: "test-model", family: "arithmetic", tier: 0, seed: 1, prompt: "What is 2+2?", expected: "4", response: "14", pass: false, latencyMs: 1 };
const encoded = (rows = [row]) => [...rows, { type: "summary", adapter: rows[0].adapter, total: rows.length, passed: rows.filter((r) => r.pass).length, errors: rows.filter((r) => "error" in r).length }].map((r) => JSON.stringify(r)).join("\n");

describe("auditable reports", () => {
  test("versioned manifests bind their actual prompts, answers, and selections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-manifest-"));
    const path = join(dir, "oracle.jsonl");
    try {
      await recordRun(oracle, { families: ["echo"], seeds: [1] }, path);
      const original = readFileSync(path, "utf8");
      expect(parseRun(original).rows).toHaveLength(1);
      const records = original.trim().split("\n").map((line) => JSON.parse(line));
      records[1].prompt += " altered";
      expect(() => parseRun(records.map((record) => JSON.stringify(record)).join("\n"))).toThrow("suite hash");
      const selection = original.replace('"seeds":[1]', '"seeds":[2]');
      expect(() => parseRun(selection)).toThrow("selection");
    } finally { rmSync(dir, { recursive: true }); }
  });

  test("refusals and truncation cannot gain passes when reports are replayed", () => {
    for (const flagged of [{ ...row, response: "4", truncated: true }, { ...row, response: "4", refused: true }]) {
      const report = buildReport([parseRun(encoded([flagged]))]);
      expect(report.models[0].all.n).toBe(1);
      expect(report.models[0].all.passed).toBe(0);
      expect(report.models[0].all.finalAnswerMatches).toBe(0);
    }
  });

  test("recomputes both metrics rather than trusting recorded verdicts", () => {
    const report = buildReport([parseRun(encoded([{ ...row, response: "-4", pass: true }]))]);
    expect(report.models[0].all.passed).toBe(0);
    expect(report.models[0].all.finalAnswerMatches).toBe(0);
    expect(report.models[0].rescored.lostPasses).toBe(1);
    expect(report.seeds).toEqual([1]);
  });

  test("final blocks do not match numeric suffixes and errors never count as matches", () => {
    const error = { ...row, seed: 2, prompt: "", expected: "", response: "", error: "HTTP 503" };
    const report = buildReport([parseRun(encoded([row, error]))]);
    expect(report.models[0].all.errors).toBe(1);
    expect(report.models[0].all.n).toBe(1);
    expect(report.models[0].all.finalAnswerMatches).toBe(0);
  });

  test("correct final blocks remain a separate diagnostic", () => {
    const report = buildReport([parseRun(encoded([{ ...row, response: "Work shown here.\n\n4" }]))]);
    expect(report.models[0].all.strict).toBe(0);
    expect(report.models[0].all.finalAnswer).toBe(1);
    expect(report.models[0].all.formatOnly).toBe(1);
  });

  test("rejects incomplete, duplicate, malformed, or inconsistent runs", () => {
    expect(() => parseRun(JSON.stringify(row))).toThrow();
    expect(() => parseRun(encoded([row, row]))).toThrow();
    expect(() => parseRun(encoded().replace('"total":1', '"total":2'))).toThrow();
    expect(() => parseRun(encoded() + "\n{" )).toThrow();
    expect(() => parseRun(encoded([{ ...row, seed: 1.5 }]))).toThrow();
    expect(() => parseRun(encoded([{ ...row, response: "x".repeat(65_537) }]))).toThrow();
  });

  test("cannot silently compare different coverage, model duplicates, or prompts", () => {
    const a = parseRun(encoded());
    const b = parseRun(encoded([{ ...row, adapter: "other", seed: 2 }]));
    const c = parseRun(encoded([{ ...row, adapter: "other", prompt: "a different task" }]));
    expect(() => buildReport([a, b])).toThrow();
    expect(() => buildReport([a, c])).toThrow();
    expect(() => buildReport([a, a])).toThrow();
  });

  test("exclusions are explicit and preserve all-instance totals", () => {
    const report = buildReport([parseRun(encoded())], ["arithmetic"]);
    expect(report.models[0].all.total).toBe(1);
    expect(report.models[0].excluded).toBe(1);
    expect(report.models[0].eligible.strict).toBeNull();
    expect(report.excludedFamilies).toEqual(["arithmetic"]);
  });
});
