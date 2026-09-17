import type { Family } from "../family.ts";
import { rng } from "../rng.ts";
import { NAMES } from "./words.ts";

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) { yield items.slice(); return; }
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const p of permutations(rest)) yield [items[i], ...p];
  }
}

/**
 * Tier 3: total ordering from pairwise clues. Construction picks the true order
 * first, emits clues consistent with it, and brute-forces all permutations to
 * require uniqueness.
 */
export const ordering: Family = {
  name: "ordering",
  tiers: [3],
  generate(tier, seed) {
    const r = rng(seed);
    for (let attempt = 0; attempt < 200; attempt++) {
      const n = 4;
      const people = r.shuffle(NAMES.slice(0, n * 2)).slice(0, n);
      const truth = r.shuffle(people.slice()); // truth[0] is tallest, etc.
      const rank = new Map(truth.map((p, i) => [p, i]));
      // Clue pool: "X finished before Y" for true pairs.
      const clues: [string, string][] = [];
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) clues.push([truth[i], truth[j]]);
      r.shuffle(clues);
      const take = r.intBetween(4, 6);
      const chosen = clues.slice(0, take);
      // Uniqueness check: enumerate permutations consistent with clues.
      let solutions = 0;
      for (const p of permutations(people)) {
        const pr = new Map(p.map((x, i) => [x, i]));
        if (chosen.every(([a, b]) => pr.get(a)! < pr.get(b)!)) solutions++;
        if (solutions > 1) break;
      }
      if (solutions !== 1) continue;
      const names = people.map((p, i) => `${String.fromCharCode(65 + i)}=${p}`).join(", ");
      const text = chosen
        .map(([a, b]) => `${a} finished before ${b}`)
        .join("; ");
      const letters = people.map((_, i) => String.fromCharCode(65 + i));
      const order = truth.map((p) => letters[people.indexOf(p)]).join(" ");
      return {
        family: this.name,
        tier,
        seed,
        prompt: `Four runners (${names}) finished a race. Clues: ${text}. List the finish order from first to last as the letters, separated by spaces. Reply with only the letters.`,
        answer: order,
      };
    }
    throw new Error(`ordering: no unique puzzle for seed ${seed}`);
  },
};
