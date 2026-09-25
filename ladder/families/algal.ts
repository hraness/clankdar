import type { Family } from "../family.ts";
import { rng, mixSeed } from "../rng.ts";
import { evalProgram, checkProgram } from "#clankdar-algal-runtime";
import type { JsonObject, JsonValue } from "../algal/abi.ts";
import { ALGAL_EXPR_CONTRACT, ALGAL_FUEL_LIMIT, ALGAL_WASM_SHA256 } from "../algal/provenance.ts";

export interface AlgalPuzzle {
  expr: { contract: typeof ALGAL_EXPR_CONTRACT; program: JsonValue };
  inputs: JsonObject;
  fuelLimit: typeof ALGAL_FUEL_LIMIT;
}
const get = (...path: JsonValue[]): JsonValue => ["get", ...path];
const expression = (program: JsonValue, inputs: JsonObject): AlgalPuzzle => ({ expr: { contract: ALGAL_EXPR_CONTRACT, program }, inputs, fuelLimit: ALGAL_FUEL_LIMIT });
const sum = (list: JsonValue): JsonValue => ["fold", list, 0, "sum", "item", ["add", get("sum"), get("item")]];
const squaresAbove = (values: JsonValue, cutoff: JsonValue): JsonValue => sum([
  "map", ["filter", values, "x", ["gt", get("x"), cutoff]], "x", ["mul", get("x"), get("x")],
]);

/** Reference solution is real ALGAL execution, never a second JS implementation. */
export function solveAlgalPuzzle(puzzle: AlgalPuzzle): { answer: string; fuel: number } {
  if (puzzle.expr.contract !== ALGAL_EXPR_CONTRACT || puzzle.fuelLimit !== ALGAL_FUEL_LIMIT) throw new Error("unsupported ALGAL puzzle contract");
  const checked = checkProgram(puzzle.expr.program, Object.keys(puzzle.inputs));
  if (!checked.ok) throw new Error(`ALGAL puzzle is invalid: ${checked.err.code}`);
  const result = evalProgram(puzzle.expr.program, puzzle.inputs, puzzle.fuelLimit);
  if (!result.ok) throw new Error(`ALGAL puzzle failed: ${result.err.code}`);
  if (typeof result.value !== "number" || !Number.isSafeInteger(result.value)) throw new Error("ALGAL puzzle must produce a safe integer");
  return { answer: String(result.value), fuel: result.fuel };
}

/** Public worked example; build-time execution keeps its displayed answer honest. */
export function algalWorkedExample() {
  const puzzle = expression(squaresAbove(get("values"), 2), { values: [1, 3, 2, 5] });
  return { ...puzzle, ...solveAlgalPuzzle(puzzle) };
}

/** Frozen clankdar-algal-v1 generation. Tiers describe structure, not model classes. */
export function createAlgalPuzzle(tier: number, seed: number): AlgalPuzzle {
  if (![1, 2, 3].includes(tier) || !Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new Error("ALGAL puzzle requires tier 1..3 and uint32 seed");
  const r = rng(mixSeed(`algal:t${tier}`, seed));
  if (tier === 1) {
    const cutoff = r.intBetween(4, 10);
    const values = Array.from({ length: 8 }, () => r.intBetween(1, 20));
    values[0] = cutoff + 1;
    return expression(squaresAbove(get("values"), get("cutoff")), { values, cutoff });
  }
  if (tier === 2) {
    const coefficients = Array.from({ length: 3 }, () => r.intBetween(1, 7));
    const inputs = { values: Array.from({ length: 10 }, () => r.intBetween(1, 20)), start: Array.from({ length: 3 }, () => r.intBetween(1, 9)), coefficients, modulus: 97 };
    const next: JsonValue = ["mod", ["add", ...coefficients.map((_, i): JsonValue => ["mul", get("coefficients", i), get("state", i)]), get("item")], get("modulus")];
    return expression(["nth", ["fold", get("values"), get("start"), "state", "item", ["list", get("state", 1), get("state", 2), next]], 2], inputs);
  }
  const width = 4;
  const inputs = {
    matrix: Array.from({ length: width }, () => Array.from({ length: width }, () => r.intBetween(0, 2))),
    start: Array.from({ length: width }, () => r.intBetween(1, 5)),
    indices: Array.from({ length: width }, (_, i) => i),
    rounds: Array.from({ length: 12 }, (_, i) => i), modulus: 997, target: r.int(width),
  };
  const dot: JsonValue = ["fold", get("indices"), 0, "sum", "i", ["add", get("sum"), ["mul", get("row", get("i")), get("state", get("i"))]]];
  const step: JsonValue = ["map", get("matrix"), "row", ["mod", dot, get("modulus")]];
  return expression(["nth", ["fold", get("rounds"), get("start"), "state", "round", step], get("target")], inputs);
}

export const algal: Family = {
  name: "algal", tiers: [1, 2, 3],
  generate(tier, seed) {
    const puzzle = createAlgalPuzzle(tier, seed);
    const { answer } = solveAlgalPuzzle(puzzle);
    return {
      family: "algal", tier, seed,
      prompt: `Evaluate this algal.expr.v1 program with the supplied inputs. Reply with only the final integer.

An array is an operation call. get reads an input or a bound variable, followed by optional zero-based array indexes. filter keeps items whose predicate is true; map transforms every item; fold processes a list left to right, binding its accumulator and item names on each step. list constructs an array; nth selects an index; add, mul, gt and mod mean sum, product, greater-than and remainder. Bindings are lexical and every iteration sees the previous accumulator.

Expression: ${JSON.stringify(puzzle.expr)}
Inputs: ${JSON.stringify(puzzle.inputs)}
Fuel limit: ${puzzle.fuelLimit}
Evaluator SHA-256: ${ALGAL_WASM_SHA256}`,
      answer,
    };
  },
};
