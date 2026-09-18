import type { Family, ToolEnv } from "../family.ts";
import { mixSeed } from "../rng.ts";
import { sat } from "./sat.ts";
import type { Clause } from "./sat.ts";

function build(tier: number, seed: number, satSeed: number) {
    const base = sat.generate(tier, satSeed);
    const n = base.answer.length;
    const clauses: Clause[] = [...base.prompt.matchAll(/\(([^)]+)\)/g)].map((m) =>
      m[1].split(" ∨ ").map((t) => (Number(t.replace("¬", "").slice(1)) << 1) | (t.startsWith("¬") ? 0 : 1)) as Clause,
    );
    const env: ToolEnv = {
      budget: { maxCalls: 4, maxTurns: 8 },
      tools: {
        check(args) {
          const bits = (args as { bits?: unknown }).bits;
          if (typeof bits !== "string" || !new RegExp(`^[01]{${n}}$`).test(bits)) throw new Error("bad bits");
          const mask = [...bits].reduce((m, c, i) => m | (Number(c) << i), 0);
          const ok = clauses.every((c) => c.some((lit) => ((mask >> (lit >> 1)) & 1) === (lit & 1)));
          return ok ? "satisfies" : "fails";
        },
      },
    };
    const tail = `Reply with only the ${n}-digit assignment as bits, in order x0 first through x${n - 1} last.`;
    const body = base.prompt.replace(tail, `Submit via FINAL: the ${n}-digit assignment as bits, in order x0 first through x${n - 1} last.`);
    if (body === base.prompt) throw new Error("satcheck: sat prompt tail did not match");
    return {
      family: "satcheck" as const,
      tier,
      seed,
      prompt: `You are being evaluated as a tool-using agent. On each turn reply with exactly ONE line in one of these forms:
TOOL <name> <json-object-args>
FINAL <answer>
Available tools:
- check {"bits": "<${n} bits, x0 first>"} returns "satisfies" or "fails" for a candidate assignment.
You may make at most 4 tool calls.

${body}`,
      answer: base.answer,
      env,
    };
}

/**
 * Frozen agent-v0 pool: delegates to sat.generate with the raw seed, so its
 * sat:t5 instances are identical to the frontier pool's — kept only to
 * regenerate the published agent-v0 archive.
 */
export const satcheckV0: Family = {
  name: "satcheck",
  tiers: [5],
  generate: (tier, seed) => build(tier, seed, seed),
};

/**
 * Agent v1+: a unique-solution 3-SAT instance plus a bounded `check` tool
 * that reports whether a candidate assignment satisfies the formula. The
 * budget (4 calls) is far below the search space, so the tool supports
 * verification, not brute force. The seed is mixed under this family's own
 * label so instances do not overlap the frontier sat pool.
 */
export const satcheck: Family = {
  name: "satcheck",
  tiers: [5],
  generate: (tier, seed) => build(tier, seed, mixSeed("satcheck:t5", seed)),
};
