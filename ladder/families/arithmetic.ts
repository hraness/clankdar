import type { Family } from "../family.ts";
import { rng } from "../rng.ts";

type Node = { text: string; value: number };

/** Build a fully parenthesized expression tree of bounded depth with integer values. */
function expr(r: ReturnType<typeof rng>, depth: number, root = false): Node {
  if (depth === 0 || (!root && r.chance(0.25))) {
    const v = r.intBetween(2, 19);
    return { text: String(v), value: v };
  }
  const left = expr(r, depth - 1);
  const op = r.pick(["+", "-", "*", "/"] as const);
  if (op === "/") {
    // Right subtree evaluates to a nonzero divisor; make the left a multiple
    // of its *signed* value so the quotient is exactly k.
    const d = expr(r, depth - 1);
    if (d.value === 0) {
      const v = r.intBetween(2, 19);
      return { text: `(0 + ${v})`, value: v };
    }
    const k = r.intBetween(1, 9) * (r.chance(0.5) ? -1 : 1);
    const dividend: Node = { text: String(k * d.value), value: k * d.value };
    return { text: `(${dividend.text} / ${d.text})`, value: k };
  }
  const right = expr(r, depth - 1);
  const value =
    op === "+" ? left.value + right.value
    : op === "-" ? left.value - right.value
    : left.value * right.value;
  return { text: `(${left.text} ${op} ${right.text})`, value };
}

/** Tiers 0-2: one op at the floor, deeper trees above. */
export const arithmetic: Family = {
  name: "arithmetic",
  tiers: [0, 1, 2],
  generate(tier, seed) {
    const r = rng(seed);
    let prompt: string, answer: number;
    if (tier === 0) {
      const a = r.intBetween(2, 12), b = r.intBetween(2, 12);
      prompt = `What is ${a} + ${b}? Reply with only the number.`;
      answer = a + b;
    } else {
      const depth = tier === 1 ? 2 : 3;
      const e = expr(r, depth, true);
      prompt = `Compute ${e.text}. Work left to right inside parentheses first. Reply with only the integer result.`;
      answer = e.value;
    }
    return { family: this.name, tier, seed, prompt, answer: String(answer) };
  },
};
