export type { Family, Instance, Puzzle, AnswerFormat } from "./family.ts";
export { normalize, answersMatch, answerFormat, canonicalAnswer, scoreAnswer, SCORER_VERSION } from "./family.ts";
export const SUITE_VERSION = "clankdar-suite-v2";
export { answerCommitment, verifyAnswer } from "./commit.ts";
export { rng } from "./rng.ts";

import type { Family } from "./family.ts";
import { echo } from "./families/echo.ts";
import { arithmetic } from "./families/arithmetic.ts";
import { strings } from "./families/strings.ts";
import { sequence } from "./families/sequence.ts";
import { cipher } from "./families/cipher.ts";
import { ordering } from "./families/ordering.ts";
import { gridpath } from "./families/gridpath.ts";
import { knights } from "./families/knights.ts";
import { registervm } from "./families/registervm.ts";
import { sudoku } from "./families/sudoku.ts";
import { cryptarithm } from "./families/cryptarithm.ts";
import { automata } from "./families/automata.ts";
import { hiddenfn } from "./families/hiddenfn.ts";
import { gridxf } from "./families/gridxf.ts";

/** The versioned suite: every family and the tiers it covers. */
export const FAMILIES: readonly Family[] = Object.freeze([
  echo, arithmetic, strings, sequence, cipher,
  ordering, gridpath, knights, registervm, sudoku,
  cryptarithm, automata, hiddenfn, gridxf,
].map((family) => Object.freeze({
  name: family.name,
  tiers: Object.freeze([...family.tiers]),
  generate(tier: number, seed: number) {
    if (!family.tiers.includes(tier)) throw new Error(`unsupported tier for ${family.name}`);
    return family.generate(tier, seed);
  },
})));

export function familyByName(name: string): Family | undefined {
  return FAMILIES.find((f) => f.name === name);
}

/** All (family, tier) cells in a suite, optionally filtered. */
export function suiteCells(opts: { families?: string[]; tiers?: number[] }): { family: Family; tier: number }[] {
  if (opts.families && (!opts.families.length || opts.families.some((name) => !familyByName(name)))) throw new Error("unknown or empty family selection");
  if (opts.tiers && (!opts.tiers.length || opts.tiers.some((tier) => !Number.isInteger(tier) || tier < 0 || tier > 6))) throw new Error("tiers must be integers from 0 to 6");
  const cells: { family: Family; tier: number }[] = [];
  for (const f of FAMILIES) {
    if (opts.families && !opts.families.includes(f.name)) continue;
    for (const t of f.tiers) {
      if (opts.tiers && !opts.tiers.includes(t)) continue;
      cells.push({ family: f, tier: t });
    }
  }
  if (!cells.length) throw new Error("selection contains no family/tier cells");
  return cells;
}
