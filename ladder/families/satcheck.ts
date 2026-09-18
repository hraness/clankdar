import type { Family, ToolEnv } from "../family.ts";
import { sat } from "./sat.ts";
import type { Clause } from "./sat.ts";

/**
 * Agent pool: a unique-solution 3-SAT instance plus a bounded `check` tool
 * that reports whether a candidate assignment satisfies the formula. The
 * budget (4 calls) is far below the search space, so the tool supports
 * verification, not brute force.
 */
export const satcheck: Family = {
  name: "satcheck",
  tiers: [5],
  generate(tier, seed) {
    const base = sat.generate(tier, seed);
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
    const body = base.prompt.replace(
      `Reply with only the ${n}-digit assignment as bits, in order x0 first through x${n - 1} last.`,
      `Submit via FINAL: the ${n}-digit assignment as bits, in order x0 first through x${n - 1} last.`,
    );
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
  },
};
