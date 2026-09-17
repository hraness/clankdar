import type { Family } from "../family.ts";
import { rng, type Rng } from "../rng.ts";
import { WORDS } from "./words.ts";

interface FnSpec { desc: string; apply: (x: number) => number; domain: [number, number] }

export function integerCandidates(tier: number): ((x: number) => number)[] {
  const rules: ((x: number) => number)[] = [];
  if (tier === 5) {
    for (let a = 2; a <= 7; a++) for (let b = 1; b <= 15; b++) rules.push((x) => a * x + b);
    for (let a = 2; a <= 6; a++) for (const m of [10, 12, 16]) rules.push((x) => (a * x + 1) % m);
    for (let k = 3; k <= 30; k++) rules.push((x) => x ^ k);
  } else {
    for (let a = 2; a <= 5; a++) for (let b = 1; b <= 9; b++) for (const m of [11, 13, 17]) rules.push((x) => (a * x + b) % m + x % 2);
    for (let k = 3; k <= 15; k++) for (let s = 1; s <= 3; s++) rules.push((x) => (x ^ k) + s * (x % 3));
  }
  return rules;
}

export function wordCandidates(): ((word: string) => string)[] {
  return [
    ...Array.from({ length: 5 }, (_, i) => (word: string) => [...word].reverse().map((c) => String.fromCharCode(97 + (c.charCodeAt(0) - 97 + i + 1) % 26)).join("")),
    (word) => word.at(-1)! + word + word[0],
    (word) => [...word].filter((_, i) => i % 2 === 0).join("") + [...word].filter((_, i) => i % 2 !== 0).join(""),
  ];
}

function distinguish<T extends string | number>(apply: (x: T) => T, rules: ((x: T) => T)[], inputs: T[], query: T, pool: T[]): T[] {
  let remaining = rules.filter((rule) => inputs.every((input) => rule(input) === apply(input)));
  while (new Set(remaining.map((rule) => rule(query))).size > 1) {
    const input = pool.find((x) => x !== query && !inputs.includes(x) && new Set(remaining.map((rule) => rule(x))).size > 1);
    if (input === undefined) throw new Error("hiddenfn: cannot disambiguate the query");
    inputs.push(input);
    remaining = remaining.filter((rule) => rule(input) === apply(input));
  }
  if (!remaining.length) throw new Error("hiddenfn: rule outside the declared grammar");
  return inputs;
}

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
      distinguish(f.apply, wordCandidates(), inputs, test, WORDS.slice());
      const examples = inputs.map((w) => `f(${w}) = ${f.apply(w)}`).join("\n");
      return {
        family: this.name,
        tier,
        seed,
        prompt: `A hidden rule maps each word to a word. The rule is one of: shift every letter forward by k places (wrapping z to a), then reverse, for integer k in 1..5; prepend the last letter and append the first letter of the original word; or concatenate the letters at even zero-based indices followed by the letters at odd indices. Examples:\n${examples}\n\nApply the same rule: f(${test}) = ? Reply with only the resulting word, lowercase.`,
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
    const pool = Array.from({ length: f.domain[1] - f.domain[0] + 1 }, (_, i) => f.domain[0] + i);
    distinguish(f.apply, integerCandidates(tier), inputs, test, pool);
    const grammar = tier === 5
      ? "a*x+b (a in 2..7, b in 1..15); (a*x+1) mod m (a in 2..6, m in {10,12,16}); or x XOR k (k in 3..30)"
      : "((a*x+b) mod m)+(x mod 2) (a in 2..5, b in 1..9, m in {11,13,17}); or (x XOR k)+s*(x mod 3) (k in 3..15, s in 1..3)";
    const examples = inputs.map((x) => `f(${x}) = ${f.apply(x)}`).join("\n");
    return {
      family: this.name,
      tier,
      seed,
      prompt: `A hidden rule maps integers to integers. The rule is one of: ${grammar}. All parameters are integers; ranges are inclusive, mod is the nonnegative remainder, and XOR is bitwise exclusive-or. Examples:\n${examples}\n\nApply the same rule: f(${test}) = ? Reply with only the integer.`,
      answer: String(f.apply(test)),
    };
  },
};
