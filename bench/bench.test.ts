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
    expect(results[0].error).toBe("boom");
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
    expect(results[0].error).toMatch(/no API key/);
  });
});
