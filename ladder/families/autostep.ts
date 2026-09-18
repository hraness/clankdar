import type { Family, ToolEnv } from "../family.ts";
import { rng, mixSeed } from "../rng.ts";

function step(row: number[], rule: number): number[] {
  const w = row.length;
  return row.map((_, i) => {
    const l = i > 0 ? row[i - 1] : 0, rt = i < w - 1 ? row[i + 1] : 0;
    return (rule >> ((l << 2) | (row[i] << 1) | rt)) & 1;
  });
}

const RULES = [30, 54, 60, 90, 110, 150, 182, 250];
/** Agent v1+: convergent rules 182/250 collapse to all-ones rows (see automata.ts). */
const RULES_STABLE = [30, 54, 60, 90, 110, 150, 22, 73];
const TIER_PARAMS: Record<number, { w: number; steps: number }> = {
  5: { w: 17, steps: 5 },
  6: { w: 21, steps: 7 },
  7: { w: 25, steps: 10 },
};

function build(tier: number, seed: number, rules: readonly number[] = RULES) {
  const r = rng(mixSeed(`autostep:t${tier}`, seed));
  const { w, steps } = TIER_PARAMS[tier];
  const rule = r.pick(rules);
  let row: number[] = Array.from({ length: w }, () => (r.chance(0.4) ? 1 : 0));
  if (!row.some(Boolean)) row[r.int(w)] = 1;
  const start = row.join("");
  for (let i = 0; i < steps; i++) row = step(row, rule);
  const env: ToolEnv = {
    budget: { maxCalls: steps + 2, maxTurns: steps + 6 },
    tools: {
      ca_step(args) {
        const a = args as { rule?: unknown; row?: unknown };
        if (!Number.isInteger(a.rule) || (a.rule as number) < 0 || (a.rule as number) > 255) throw new Error("bad rule");
        if (typeof a.row !== "string" || !/^[01]{1,64}$/.test(a.row)) throw new Error("bad row");
        return step([...a.row].map(Number), a.rule as number).join("");
      },
    },
  };
  return {
    family: "autostep" as const,
    tier,
    seed,
    prompt: `You are being evaluated as a tool-using agent. On each turn reply with exactly ONE line in one of these forms:
TOOL <name> <json-object-args>
FINAL <answer>
Available tools:
- ca_step {"rule": <int 0-255>, "row": "<bits>"} returns the next row of the elementary cellular automaton (positions outside the row are 0).
You may make at most ${steps + 2} tool calls.

A one-dimensional cellular automaton uses elementary rule ${rule}. Starting row is:

${start}

After exactly ${steps} steps, what is the row? Reply via FINAL with only the ${w} digits of 0s and 1s.`,
    answer: row.join(""),
    env,
  };
}

/** Frozen agent-v0 pool: regenerates the published archive exactly. */
export const autostepV0: Family = {
  name: "autostep",
  tiers: [5, 6, 7],
  generate: build,
};

/** Agent v1+: cellular-automaton evaluation with a per-step tool. */
export const autostep: Family = {
  name: "autostep",
  tiers: [5, 6, 7],
  generate: (tier, seed) => build(tier, seed, RULES_STABLE),
};
