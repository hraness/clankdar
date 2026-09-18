export type { Family, Instance, Puzzle, AnswerFormat } from "./family.ts";
export { normalize, answersMatch, answerFormat, canonicalAnswer, scoreAnswer, SCORER_VERSION } from "./family.ts";
export const SUITE_VERSION = "clankdar-suite-v2";
/** Published frozen suite: deeper unaided cells incl. the legacy CA rule pool. */
export const FRONTIER_SUITE_VERSION_V0 = "clankdar-frontier-v0";
export const FRONTIER_SUITE_VERSION = "clankdar-frontier-v1";
/** Published frozen suite: satcheck shared the frontier sat stream; CA pool included convergent rules. */
export const AGENT_SUITE_VERSION_V0 = "clankdar-agent-v0";
export const AGENT_SUITE_VERSION = "clankdar-agent-v1";
export const AGENT_SUITE_VERSIONS: ReadonlySet<string> = new Set([AGENT_SUITE_VERSION_V0, AGENT_SUITE_VERSION]);
export const KNOWN_SUITE_VERSIONS: readonly string[] = Object.freeze([SUITE_VERSION, FRONTIER_SUITE_VERSION_V0, FRONTIER_SUITE_VERSION, AGENT_SUITE_VERSION_V0, AGENT_SUITE_VERSION]);
export type SuiteName = "v2" | "frontier" | "agent";
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
import { knights, knightsDeep } from "./families/knights.ts";
import { registervm, registervmDeep } from "./families/registervm.ts";
import { sudoku } from "./families/sudoku.ts";
import { cryptarithm, cryptarithmDeep } from "./families/cryptarithm.ts";
import { automata, automataDeep, automataDeepV0 } from "./families/automata.ts";
import { hiddenfn } from "./families/hiddenfn.ts";
import { gridxf, gridxfDeep } from "./families/gridxf.ts";
import { sat } from "./families/sat.ts";
import { bitcircuit } from "./families/bitcircuit.ts";
import { bitmatrix } from "./families/bitmatrix.ts";
import { relayvm } from "./families/relayvm.ts";
import { autostep, autostepV0 } from "./families/autostep.ts";
import { satcheck, satcheckV0 } from "./families/satcheck.ts";

function freeze(families: readonly Family[]): readonly Family[] {
  return Object.freeze(families.map((family) => Object.freeze({
    name: family.name,
    tiers: Object.freeze([...family.tiers]),
    generate(tier: number, seed: number) {
      if (!family.tiers.includes(tier)) throw new Error(`unsupported tier for ${family.name}`);
      return family.generate(tier, seed);
    },
  })));
}

/** The published v2 suite: frozen family/tier coverage for the recorded calibration. */
export const FAMILIES: readonly Family[] = freeze([
  echo, arithmetic, strings, sequence, cipher,
  ordering, gridpath, knights, registervm, sudoku,
  cryptarithm, automata, hiddenfn, gridxf,
]);

/**
 * The published frontier pool: deeper unaided cells. Tier numbers continue
 * each family's own scale (automata t6 is harder than t5); the suite version
 * keeps results strictly separate from v2 evidence. v1 swaps the convergent
 * CA rules 182/250 for non-convergent ones.
 */
export const FRONTIER_FAMILIES: readonly Family[] = freeze([
  sat, bitmatrix, bitcircuit,
  knightsDeep, registervmDeep, cryptarithmDeep, automataDeep, gridxfDeep,
]);

/**
 * The published bounded tool-agent pool: instances carry deterministic
 * server-side tool environments and prompts documenting the TOOL/FINAL
 * protocol. Results are never comparable to unaided suites. v1 decorrelates
 * satcheck from the frontier sat stream and uses non-convergent CA rules.
 */
export const AGENT_FAMILIES: readonly Family[] = freeze([
  relayvm, autostep, satcheck,
]);

/** Frozen pools that exactly regenerate the published v0 archives. */
export const FRONTIER_FAMILIES_V0: readonly Family[] = freeze([
  sat, bitmatrix, bitcircuit,
  knightsDeep, registervmDeep, cryptarithmDeep, automataDeepV0, gridxfDeep,
]);
export const AGENT_FAMILIES_V0: readonly Family[] = freeze([
  relayvm, autostepV0, satcheckV0,
]);

export function suiteVersion(name: SuiteName): string {
  return name === "frontier" ? FRONTIER_SUITE_VERSION : name === "agent" ? AGENT_SUITE_VERSION : SUITE_VERSION;
}

export function suitePool(name: SuiteName): readonly Family[] {
  return name === "frontier" ? FRONTIER_FAMILIES : name === "agent" ? AGENT_FAMILIES : FAMILIES;
}

export function poolForVersion(version: string): readonly Family[] {
  if (version === SUITE_VERSION) return FAMILIES;
  if (version === FRONTIER_SUITE_VERSION_V0) return FRONTIER_FAMILIES_V0;
  if (version === FRONTIER_SUITE_VERSION) return FRONTIER_FAMILIES;
  if (version === AGENT_SUITE_VERSION_V0) return AGENT_FAMILIES_V0;
  if (version === AGENT_SUITE_VERSION) return AGENT_FAMILIES;
  throw new Error(`unknown suite version: ${version}`);
}

export function familyByName(name: string): Family | undefined {
  return FAMILIES.find((f) => f.name === name);
}

/** Every registered family object whose name and tier cover the cell. */
export function cellSupported(name: string, tier: number, pool?: readonly Family[]): boolean {
  return (pool ?? [...FAMILIES, ...FRONTIER_FAMILIES, ...AGENT_FAMILIES]).some((f) => f.name === name && f.tiers.includes(tier));
}

/** All (family, tier) cells in a suite, optionally filtered. */
export function suiteCells(opts: { families?: string[]; tiers?: number[]; suite?: SuiteName }): { family: Family; tier: number }[] {
  const pool = suitePool(opts.suite ?? "v2");
  if (opts.families && (!opts.families.length || opts.families.some((name) => !pool.some((f) => f.name === name)))) throw new Error("unknown or empty family selection");
  if (opts.tiers && (!opts.tiers.length || opts.tiers.some((tier) => !Number.isInteger(tier) || tier < 0 || tier > 8))) throw new Error("tiers must be integers from 0 to 8");
  const cells: { family: Family; tier: number }[] = [];
  for (const f of pool) {
    if (opts.families && !opts.families.includes(f.name)) continue;
    for (const t of f.tiers) {
      if (opts.tiers && !opts.tiers.includes(t)) continue;
      cells.push({ family: f, tier: t });
    }
  }
  if (!cells.length) throw new Error("selection contains no family/tier cells");
  return cells;
}
