import { describe, expect, test } from "bun:test";
import { checkProgram, evalProgram } from "#clankdar-algal-runtime";
import { algalWasmBytes } from "./algal/artifact.ts";
import { ALGAL_WASM_SHA256 } from "./algal/provenance.ts";
import { algal, algalWorkedExample, createAlgalPuzzle, solveAlgalPuzzle } from "./families/algal.ts";
import { ALGAL_FAMILIES, ALGAL_SUITE_VERSION, poolForVersion } from "./mod.ts";
import { answerFormat, canonicalAnswer, scoreAnswer } from "./family.ts";
import { createHash } from "node:crypto";

// This is the official Bun loader from the exact dependency pin, not our ABI adapter.
const reference = await import(new URL("./src/expr.ts", import.meta.resolve("@hraness/algal")).href);

describe("Frozen Algal expression suite", () => {
  test("loads the exact official evaluator with no host capabilities", () => {
    const bytes = algalWasmBytes();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(ALGAL_WASM_SHA256);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(bytes))).toEqual([]);
    expect(poolForVersion(ALGAL_SUITE_VERSION)).toBe(ALGAL_FAMILIES);
  });

  test("the worked example executes its published code, inputs, and fuel", () => {
    const example = algalWorkedExample();
    expect(example.inputs).toEqual({ values: [1, 3, 2, 5] });
    expect(example.answer).toBe("34");
    expect(example.fuel).toBe(87);
    expect(reference.evalProgram(example.expr.program, example.inputs, example.fuelLimit)).toEqual({ ok: true, value: 34, fuel: 87 });
  });

  test.each([1, 2, 3])("tier %i regenerates and agrees with the official loader under bounded work", (tier) => {
    const outputs = new Set<string>();
    for (const seed of [0, 1, 2, 7, 42, 112, 9001, 0xffff_ffff]) {
      const puzzle = createAlgalPuzzle(tier, seed);
      const result = solveAlgalPuzzle(puzzle);
      const official = reference.evalProgram(puzzle.expr.program, puzzle.inputs, puzzle.fuelLimit);
      expect(official).toEqual({ ok: true, value: Number(result.answer), fuel: result.fuel });
      expect(result.fuel).toBeGreaterThan(0);
      expect(result.fuel).toBeLessThanOrEqual(10000);
      expect(JSON.stringify(puzzle.expr.program).length).toBeLessThan(16384);
      expect(JSON.stringify(puzzle.inputs).length).toBeLessThan(4096);
      const instance = algal.generate(tier, seed);
      expect(instance).toEqual(algal.generate(tier, seed));
      expect(instance.prompt).toContain(JSON.stringify(puzzle.expr));
      expect(instance.prompt).toContain(JSON.stringify(puzzle.inputs));
      expect(instance.answer).toBe(result.answer);
      expect(canonicalAnswer(instance.answer, answerFormat("algal"))).toBe(result.answer);
      outputs.add(result.answer);
    }
    expect(outputs.size).toBeGreaterThan(1);
  });

  test("typed integer scoring preserves signs and rejects prose and partial answers", () => {
    expect(answerFormat("algal")).toBe("integer");
    expect(scoreAnswer("34", " +034 ", "integer").pass).toBe(true);
    expect(scoreAnswer("34", "-34", "integer").pass).toBe(false);
    expect(scoreAnswer("34", "3 4", "integer").pass).toBe(false);
    expect(scoreAnswer("34", "answer: 34", "integer")).toMatchObject({ pass: false, formatOnly: true });
  });

  test("malformed programs, dangerous operations, strict types, fuel and byte limits fail closed", () => {
    for (const program of [["shell", "ls"], ["fetch", "https://example.com"], ["if", 1, 2, 3], ["get", "absent"]]) {
      expect(evalProgram(program, {})).toEqual(reference.evalProgram(program, {}, 10000));
      expect(evalProgram(program, {}).ok).toBe(false);
    }
    expect(checkProgram(["get", "typo"], [])).toMatchObject({ ok: false, err: { code: "EXPR_PATH" } });
    expect(evalProgram(["add", 1, 2], {}, 1)).toMatchObject({ ok: false, err: { code: "EXPR_FUEL" } });
    expect(() => evalProgram(1, {}, 10001)).toThrow("fuel");
    expect(() => evalProgram(["get", "value"], { value: "x".repeat(65536) })).toThrow("byte limit");
    for (const [tier, seed] of [[0, 0], [4, 0], [1, -1], [1, 0x1_0000_0000], [1, 1.5]]) expect(() => createAlgalPuzzle(tier, seed)).toThrow("uint32");
  });
});
