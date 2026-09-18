import type { Family } from "../family.ts";
import { rng, mixSeed } from "../rng.ts";

const RULES = [30, 54, 60, 90, 110, 150, 182, 250];

function step(row: number[], rule: number): number[] {
  const w = row.length;
  const next = new Array<number>(w).fill(0);
  for (let i = 0; i < w; i++) {
    const l = i > 0 ? row[i - 1] : 0;
    const c = row[i];
    const rt = i < w - 1 ? row[i + 1] : 0;
    next[i] = (rule >> ((l << 2) | (c << 1) | rt)) & 1;
  }
  return next;
}

const TIER_PARAMS: Record<number, { w: number; steps: number }> = {
  4: { w: 13, steps: 3 },
  5: { w: 17, steps: 5 },
  6: { w: 21, steps: 7 },
  7: { w: 25, steps: 10 },
};

function build(tier: number, seed: number) {
  const r = rng(seed);
  const { w, steps } = TIER_PARAMS[tier];
  const rule = r.pick(RULES);
  let row: number[] = Array.from({ length: w }, () => (r.chance(0.4) ? 1 : 0));
  if (!row.some(Boolean)) row[r.int(w)] = 1;
  const start = row.join("");
  for (let i = 0; i < steps; i++) row = step(row, rule);
  return {
    family: "automata" as const,
    tier,
    seed,
    prompt: `A one-dimensional cellular automaton uses elementary rule ${rule}: each cell's next state comes from its left neighbor, itself, and its right neighbor (positions outside the row are 0). Starting row (top) is:\n\n${start}\n\nAfter exactly ${steps} steps, what is the row? Reply with only the ${w} digits of 0s and 1s.`,
    answer: row.join(""),
  };
}

/** Tiers 4-5: run an elementary cellular automaton a few steps. */
export const automata: Family = {
  name: "automata",
  tiers: [4, 5],
  generate: build,
};

/** Frontier pool: tiers 6-7 with wider rows and deeper evolution. */
export const automataDeep: Family = {
  name: "automata",
  tiers: [6, 7],
  generate: (tier, seed) => ({ ...build(tier, mixSeed(`automata:t${tier}`, seed)), seed }),
};

export const _internals = { step };
