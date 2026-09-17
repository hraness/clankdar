import { describe, expect, test } from "bun:test";
import type { Adapter } from "./adapter.ts";
import { oracle, echoAdapter, adapterByName } from "./adapters.ts";
import { runBench, summarize } from "./run.ts";
import { FAMILIES } from "../ladder/mod.ts";

const small = { seeds: [1, 2, 3] };

describe("bench harness", () => {
  test("oracle passes every cell it runs", async () => {
    const results = await runBench(oracle, { ...small, tiers: [0, 2] });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.pass)).toBe(true);
    expect(results.every((r) => !r.error)).toBe(true);
  });

  test("echo fails non-echo families, passes its own", async () => {
    const results = await runBench(echoAdapter, { ...small, families: ["echo", "cipher"] });
    const byFam = summarize("echo", results).byFamily;
    expect(byFam.echo.rate).toBe(0); // echo family answers differ from the prompt
    expect(byFam.cipher.rate).toBe(0);
  });

  test("one result row per (family, tier, seed)", async () => {
    const seeds = [1, 2, 3, 4, 5];
    const results = await runBench(oracle, { families: ["arithmetic"], seeds });
    const tiers = FAMILIES.find((f) => f.name === "arithmetic")!.tiers.length;
    expect(results.length).toBe(tiers * seeds.length);
    expect(new Set(results.map((r) => `${r.family}:${r.tier}:${r.seed}`)).size).toBe(results.length);
  });

  test("adapter errors are captured, not thrown", async () => {
    const broken: Adapter = { name: "broken", solve: async () => { throw new Error("boom"); } };
    const results = await runBench(broken, { families: ["echo"], seeds: [1] });
    expect(results.length).toBe(1);
    expect(results[0].error).toBe("adapter_failed");
    expect(results[0].pass).toBe(false);
  });

  test("summary math is consistent", async () => {
    const results = await runBench(oracle, { seeds: [1, 2] });
    const s = summarize("oracle", results);
    expect(s.total).toBe(results.length);
    expect(s.passed).toBe(results.length);
    expect(s.rate).toBe(1);
    expect(Object.values(s.byTier).reduce((a, c) => a + c.n, 0)).toBe(s.total);
    expect(Object.values(s.byFamily).reduce((a, c) => a + c.n, 0)).toBe(s.total);
  });

  test("adapters never receive the expected answer or seed", async () => {
    let keys: string[] = [];
    const observer: Adapter = { name: "observer", solve: async (puzzle) => {
      keys = Object.keys(puzzle).sort();
      return "not an answer";
    } };
    await runBench(observer, { families: ["echo"], seeds: [1] });
    expect(keys).toEqual(["family", "prompt", "tier"]);
  });

  test("invalid selections and resource limits fail before inference", async () => {
    for (const opts of [
      { seeds: [] }, { seeds: [1, 1] }, { seeds: [-1] }, { seeds: [2 ** 32] },
      { seeds: [1], families: ["typo"] }, { seeds: [1], tiers: [9] },
      { seeds: [1], families: ["echo"], tiers: [6] },
      { seeds: [1], concurrency: NaN }, { seeds: [1], concurrency: 0 },
      { seeds: [1], concurrency: 1.5 }, { seeds: [1], concurrency: 65 },
    ]) await expect(runBench(oracle, opts)).rejects.toThrow();
  });

  test("solver errors retain the puzzle for audit and are separate from wrong answers", async () => {
    const broken: Adapter = { name: "broken", solve: async () => { throw new Error("private token should not be logged"); } };
    const results = await runBench(broken, { families: ["echo"], seeds: [1] });
    expect(results[0].prompt.length).toBeGreaterThan(0);
    expect(results[0].expected.length).toBeGreaterThan(0);
    expect(results[0].error).not.toContain("private token");
    const summary = summarize("broken", results);
    expect(summary.errors).toBe(1);
    expect(summary.rate).toBeNull();
  });

  test("result order and suite identity do not depend on completion order", async () => {
    let calls = 0;
    const delayed: Adapter = { name: "delayed", solve: async () => {
      const call = calls++;
      await Bun.sleep(call === 0 ? 15 : 0);
      return "wrong";
    } };
    const results = await runBench(delayed, { families: ["echo"], seeds: [2, 1], concurrency: 2 });
    expect(results.map((r) => r.seed)).toEqual([1, 2]);
    const sequential = await runBench(oracle, { families: ["echo"], seeds: [1, 2], concurrency: 1 });
    expect(results[0].suiteHash).toBe(sequential[0].suiteHash);
    expect(results[0].suiteVersion).toBe("clankdar-suite-v2");
  });

  test("a hung adapter is bounded by the runner timeout", async () => {
    const hung: Adapter = { name: "hung", solve: () => new Promise(() => {}) };
    const results = await runBench(hung, { families: ["echo"], seeds: [1], timeoutMs: 20 });
    expect(results[0].error).toBe("timeout");
    expect(results[0].finalAnswerMatch).toBe(false);
  });

  test("refused or truncated model responses remain budget outcomes, not provider errors", async () => {
    for (const detail of [{ refused: true }, { finishReason: "length" }]) {
      const adapter: Adapter = { name: "limited", solve: async () => ({ text: "velvet", ...detail }) };
      const [result] = await runBench(adapter, { families: ["echo"], seeds: [1] });
      expect(result.error).toBeUndefined();
      expect(result.pass).toBe(false);
      expect(result.finalAnswerMatch).toBe(false);
    }
  });

  test("registry rejects unsupported tiers", () => {
    for (const family of FAMILIES) expect(() => family.generate(99, 1)).toThrow();
  });

  test("adapterByName resolves builtins and rejects unknown", () => {
    expect(adapterByName("oracle").name).toBe("oracle");
    expect(adapterByName("echo").name).toBe("echo");
    expect(adapterByName("openai:gpt-x").name).toBe("openai:gpt-x");
    expect(() => adapterByName("nope")).toThrow();
  });

  test("openai adapter without a key reports a captured error", async () => {
    const prev = process.env.OPENAI_API_KEY;
    const prevB = process.env.CLANKDAR_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CLANKDAR_API_KEY;
    const results = await runBench(adapterByName("openai:test-model"), { families: ["echo"], seeds: [1] });
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    if (prevB !== undefined) process.env.CLANKDAR_API_KEY = prevB;
    expect(results[0].error).toBe("missing_api_key");
  });
});
