import { describe, expect, test } from "vitest";
import { evalProgram, checkProgram } from "#clankdar-algal-runtime";
import { algalWorkedExample, createAlgalPuzzle, solveAlgalPuzzle } from "../../ladder/families/algal.ts";

describe("Official Algal WASM in Workers", () => {
  test("uses the same expression ABI and deterministic fuel as Bun", () => {
    expect(checkProgram(["add", 1, 2], [])).toEqual({ ok: true });
    expect(evalProgram(["add", 1, 2], {})).toMatchObject({ ok: true, value: 3 });
    expect(algalWorkedExample()).toMatchObject({ answer: "34", fuel: 87 });
    for (const tier of [1, 2, 3]) {
      const puzzle = createAlgalPuzzle(tier, 42);
      expect(solveAlgalPuzzle(puzzle).fuel).toBeLessThanOrEqual(10000);
    }
  });
  test("rejects malformed operations and bounded fuel exhaustion", () => {
    expect(evalProgram(["shell", "ls"], {})).toMatchObject({ ok: false, err: { code: "EXPR_OP" } });
    expect(evalProgram(["map", ["quote", [1, 2, 3]], "x", ["mul", ["get", "x"], 2]], {}, 1)).toMatchObject({ ok: false, err: { code: "EXPR_FUEL" } });
  });
});
