import type { Family } from "../family.ts";
import { rng } from "../rng.ts";

/** Column-wise alphametic solver: counts solutions to w1 + w2 = w3 up to cap. */
function countSolutions(w1: string, w2: string, w3: string, cap: number): number {
  const letters = [...new Set(w1 + w2 + w3)];
  const assign = new Map<string, number>();
  const used = new Set<number>();
  const lead = new Set([w1[0], w2[0], w3[0]]);
  const cols = Math.max(w1.length, w2.length, w3.length);
  const at = (w: string, i: number) => w[w.length - 1 - i]; // i-th column from right

  function walk(col: number, carry: number): number {
    if (col === cols) return carry === 0 ? 1 : 0;
    const aL = at(w1, col), bL = at(w2, col), cL = at(w3, col);
    const pending = [aL, bL, cL].filter((l): l is string => !!l && !assign.has(l));
    const need = [...new Set(pending)];
    let count = 0;
    const tryAssign = (k: number) => {
      if (k === need.length) {
        const a = aL ? assign.get(aL)! : 0;
        const b = bL ? assign.get(bL)! : 0;
        const c = cL ? assign.get(cL)! : 0;
        const sum = a + b + carry;
        if (sum % 10 === c) count += walk(col + 1, Math.floor(sum / 10));
        return;
      }
      for (let d = 0; d <= 9; d++) {
        if (used.has(d)) continue;
        if (d === 0 && lead.has(need[k])) continue;
        assign.set(need[k], d); used.add(d);
        tryAssign(k + 1);
        used.delete(d); assign.delete(need[k]);
        if (count >= cap) return;
      }
    };
    tryAssign(0);
    return count;
  }
  return walk(0, 0);
}

/**
 * Tiers 4-5: alphametic addition. Built from a digit assignment so the equation
 * holds by construction, then brute-forced for uniqueness.
 */
export const cryptarithm: Family = {
  name: "cryptarithm",
  tiers: [4, 5],
  generate(tier, seed) {
    const r = rng(seed);
    const L = "ABCDEFGH";
    for (let attempt = 0; attempt < 10_000; attempt++) {
      const k = tier === 4 ? 5 : r.pick([6, 7]);
      const letters = L.slice(0, k).split("");
      const digits = r.shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]).slice(0, k);
      const map = new Map(letters.map((l, i) => [l, digits[i]]));
      const value = (w: string) => [...w].reduce((v, c) => v * 10 + map.get(c)!, 0);
      const len1 = r.pick([2, 3]), len2 = r.pick([2, 3]);
      const pickLetters = (len: number) =>
        Array.from({ length: len }, () => r.pick(letters)).join("");
      const w1 = pickLetters(len1), w2 = pickLetters(len2);
      if (map.get(w1[0]) === 0 || map.get(w2[0]) === 0) continue;
      const sum = value(w1) + value(w2);
      const sumDigits = String(sum);
      // Result word: every digit of the sum must be covered by the mapping.
      const digitToLetter = new Map([...map].map(([l, d]) => [d, l]));
      if ([...sumDigits].some((d) => !digitToLetter.has(Number(d)))) continue;
      const w3 = [...sumDigits].map((d) => digitToLetter.get(Number(d))!).join("");
      if (map.get(w3[0]) === 0) continue;
      if (countSolutions(w1, w2, w3, 2) !== 1) continue;
      return {
        family: this.name,
        tier,
        seed,
        prompt: `Each letter stands for a distinct digit 0-9 and no word starts with 0. Solve the addition ${w1} + ${w2} = ${w3}. What number does ${w3} equal? Reply with only the digits.`,
        answer: sumDigits,
      };
    }
    throw new Error(`cryptarithm: no unique puzzle for seed ${seed} tier ${tier}`);
  },
};

/** First satisfying letter→digit mapping for w1 + w2 = w3, or null. */
function firstSolution(w1: string, w2: string, w3: string): Map<string, number> | null {
  const letters = [...new Set(w1 + w2 + w3)];
  const assign = new Map<string, number>();
  const used = new Set<number>();
  const lead = new Set([w1[0], w2[0], w3[0]]);
  const cols = Math.max(w1.length, w2.length, w3.length);
  const at = (w: string, i: number) => w[w.length - 1 - i];
  let found: Map<string, number> | null = null;

  function walk(col: number, carry: number): boolean {
    if (found) return true;
    if (col === cols) {
      if (carry === 0) found = new Map(assign);
      return carry === 0;
    }
    const aL = at(w1, col), bL = at(w2, col), cL = at(w3, col);
    const need = [...new Set([aL, bL, cL].filter((l): l is string => !!l && !assign.has(l)))];
    const tryAssign = (k: number): boolean => {
      if (k === need.length) {
        const a = aL ? assign.get(aL)! : 0;
        const b = bL ? assign.get(bL)! : 0;
        const c = cL ? assign.get(cL)! : 0;
        const sum = a + b + carry;
        return sum % 10 === c && walk(col + 1, Math.floor(sum / 10));
      }
      for (let d = 0; d <= 9; d++) {
        if (used.has(d) || (d === 0 && lead.has(need[k]))) continue;
        assign.set(need[k], d); used.add(d);
        if (tryAssign(k + 1)) return true;
        used.delete(d); assign.delete(need[k]);
      }
      return false;
    };
    return tryAssign(0);
  }
  walk(0, 0);
  return found;
}

export const _internals = { countSolutions, firstSolution };
