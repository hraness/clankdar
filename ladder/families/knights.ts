import type { Family } from "../family.ts";
import { rng, type Rng } from "../rng.ts";

type Claim = { text: string; pred: (a: boolean[]) => boolean };

const L = (i: number) => String.fromCharCode(65 + i);

/** Build a claim for speaker s over n people. Subjects never include s. */
function claim(r: Rng, s: number, n: number): Claim {
  const others = [...Array(n).keys()].filter((o) => o !== s);
  const kind = r.int(5);
  if (kind === 0) {
    const o = r.pick(others);
    const k = r.chance(0.5);
    return {
      text: `${L(s)} says: "${L(o)} is a ${k ? "knight" : "knave"}."`,
      pred: (a) => a[o] === k,
    };
  }
  if (kind === 1 || kind === 2) {
    const [o1, o2] = r.shuffle(others.slice()).slice(0, 2);
    if (o2 === undefined) return claim(r, s, n); // n=2 fallback, unreachable at n>=3
    const both = kind === 1;
    const k = r.chance(0.5);
    return both
      ? {
          text: `${L(s)} says: "${L(o1)} and ${L(o2)} are both ${k ? "knights" : "knaves"}."`,
          pred: (a) => (a[o1] === k) && (a[o2] === k),
        }
      : {
          text: `${L(s)} says: "at least one of ${L(o1)} and ${L(o2)} is a ${k ? "knight" : "knave"}."`,
          pred: (a) => (a[o1] === k) || (a[o2] === k),
        };
  }
  if (kind === 3) {
    const [o1, o2] = r.shuffle(others.slice()).slice(0, 2);
    if (o2 === undefined) return claim(r, s, n);
    return {
      text: `${L(s)} says: "exactly one of ${L(o1)} and ${L(o2)} is a knight."`,
      pred: (a) => a[o1] !== a[o2],
    };
  }
  const target = r.intBetween(0, n);
  return {
    text: `${L(s)} says: "exactly ${target} of us tell the truth."`,
    pred: (a) => a.filter(Boolean).length === target,
  };
}

/**
 * Tiers 3-4: knights and knaves. Conjunctive and counting claims break the
 * complement symmetry of pure equivalence statements; every emitted puzzle is
 * brute-forced to have exactly one consistent assignment.
 */
export const knights: Family = {
  name: "knights",
  tiers: [3, 4],
  generate(tier, seed) {
    const r = rng(seed);
    const n = tier === 3 ? 3 : 4;
    const letters = [...Array(n).keys()].map(L);
    for (let attempt = 0; attempt < 800; attempt++) {
      const claims = [...Array(n).keys()].map((s) => claim(r, s, n));
      const sols: number[] = [];
      for (let mask = 0; mask < 1 << n; mask++) {
        const a = letters.map((_, i) => Boolean(mask & (1 << i)));
        if (claims.every((c, s) => a[s] === c.pred(a))) sols.push(mask);
      }
      if (sols.length !== 1) continue;
      const mask = sols[0];
      const answer = letters
        .map((l, i) => `${l}=${mask & (1 << i) ? "knight" : "knave"}`)
        .join(" ");
      return {
        family: this.name,
        tier,
        seed,
        prompt: `On an island, knights always tell the truth and knaves always lie. ${claims.map((c) => c.text).join(" ")} For each person, are they a knight or a knave? Reply in the form "A=knight B=knave ..." using the letters in order.`,
        answer,
      };
    }
    throw new Error(`knights: no unique puzzle for seed ${seed}`);
  },
};
