import type { Family } from "../family.ts";
import { rng } from "../rng.ts";

/** Tier 2: continue an integer sequence. */
export const sequence: Family = {
  name: "sequence",
  tiers: [2],
  generate(tier, seed) {
    const r = rng(seed);
    const kind = r.pick([0, 1, 2, 3]);
    const terms: number[] = [];
    if (kind === 0) {
      const a = r.intBetween(2, 15), d = r.intBetween(2, 11) * (r.chance(0.3) ? -1 : 1);
      for (let i = 0; i < 6; i++) terms.push(a + d * i);
    } else if (kind === 1) {
      const a = r.intBetween(1, 5), ratio = r.pick([2, 3]);
      for (let i = 0; i < 6; i++) terms.push(a * ratio ** i);
    } else if (kind === 2) {
      let a = r.intBetween(1, 6), b = r.intBetween(2, 8);
      terms.push(a, b);
      for (let i = 2; i < 6; i++) { const c = a + b; terms.push(c); a = b; b = c; }
    } else {
      const off = r.intBetween(1, 9);
      for (let i = 1; i <= 6; i++) terms.push(i * i + off);
    }
    const shown = terms.slice(0, -1).join(", ");
    return {
      family: this.name,
      tier,
      seed,
      prompt: `What is the next number in this sequence? ${shown}, ? The rule is one of: a constant difference; a constant integer ratio of 2 or 3; each term is the sum of the previous two; or n*n + c for n starting at 1 and a constant c. Reply with only the number.`,
      answer: String(terms[terms.length - 1]),
    };
  },
};
