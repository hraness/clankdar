import type { Family } from "../family.ts";
import { rng, type Rng } from "../rng.ts";
import { WORDS } from "./words.ts";

interface FnSpec { desc: string; apply: (x: number) => number; domain: [number, number] }

function intFn(r: Rng, tier: number): FnSpec {
  if (tier === 5) {
    const kind = r.pick([0, 1, 2]);
    if (kind === 0) {
      const a = r.intBetween(2, 7), b = r.intBetween(1, 15);
      return { desc: "an affine rule", apply: (x) => a * x + b, domain: [0, 30] };
    }
    if (kind === 1) {
      const m = r.pick([10, 12, 16]);
      const a = r.intBetween(2, 6);
      return { desc: "a modular rule", apply: (x) => (a * x + 1) % m, domain: [0, 40] };
    }
    const k = r.intBetween(3, 30);
    return { desc: "a bitwise rule", apply: (x) => x ^ k, domain: [0, 60] };
  }
  // Tier 6: two-op compositions.
  const kind = r.pick([0, 1]);
  if (kind === 0) {
    const a = r.intBetween(2, 5), b = r.intBetween(1, 9), m = r.pick([11, 13, 17]);
    return { desc: "a hidden rule", apply: (x) => ((a * x + b) % m) + (x % 2), domain: [0, 40] };
  }
  const k1 = r.intBetween(3, 15), s = r.intBetween(1, 3);
  return { desc: "a hidden rule", apply: (x) => (x ^ k1) + s * (x % 3), domain: [0, 60] };
}

function strFn(r: Rng): { desc: string; apply: (w: string) => string } {
  const kind = r.pick([0, 1, 2]);
  if (kind === 0) {
    const k = r.intBetween(1, 5);
    return {
      desc: "a hidden rule",
      apply: (w) => [...w].map((c) => String.fromCharCode(((c.charCodeAt(0) - 97 + k) % 26) + 97)).reverse().join(""),
    };
  }
  if (kind === 1) {
    return {
      desc: "a hidden rule",
      apply: (w) => w[w.length - 1] + w + w[0],
    };
  }
  return {
    desc: "a hidden rule",
    apply: (w) => [...w].filter((_, i) => i % 2 === 0).join("") + [...w].filter((_, i) => i % 2 === 1).join(""),
  };
}

/**
 * Tiers 5-6: program induction. Input/output examples are shown; the subject
 * must infer the hidden function and apply it to a new input. Integers at 5,
 * string transforms and two-op compositions at 6.
 */
export const hiddenfn: Family = {
  name: "hiddenfn",
  tiers: [5, 6],
  generate(tier, seed) {
    const r = rng(seed);
    const useString = tier === 6 && r.chance(0.5);
    if (useString) {
      const f = strFn(r);
      const inputs = r.shuffle(WORDS.slice()).slice(0, 4);
      const test = r.pick(WORDS.filter((w) => !inputs.includes(w)));
      const examples = inputs.map((w) => `f(${w}) = ${f.apply(w)}`).join("\n");
      return {
        family: this.name,
        tier,
        seed,
        prompt: `A hidden rule maps each word to a word. Examples:\n${examples}\n\nApply the same rule: f(${test}) = ? Reply with only the resulting word, lowercase.`,
        answer: f.apply(test),
      };
    }
    const f = intFn(r, tier);
    const seen = new Set<number>();
    const inputs: number[] = [];
    while (inputs.length < 4) {
      const x = r.intBetween(f.domain[0], f.domain[1]);
      if (!seen.has(x)) { seen.add(x); inputs.push(x); }
    }
    let test = r.intBetween(f.domain[0], f.domain[1]);
    while (seen.has(test)) test = r.intBetween(f.domain[0], f.domain[1]);
    const examples = inputs.map((x) => `f(${x}) = ${f.apply(x)}`).join("\n");
    return {
      family: this.name,
      tier,
      seed,
      prompt: `A hidden rule maps integers to integers. Examples:\n${examples}\n\nApply the same rule: f(${test}) = ? Reply with only the integer.`,
      answer: String(f.apply(test)),
    };
  },
};
