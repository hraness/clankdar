import type { Family } from "../family.ts";
import { rng, mixSeed } from "../rng.ts";

/** A literal is encoded as (variable index << 1) | polarity; polarity 1 means the variable appears positively. */
export type Clause = [number, number, number];

function satisfiesMask(clause: Clause, mask: number): boolean {
  return clause.some((lit) => ((mask >> (lit >> 1)) & 1) === (lit & 1));
}

/** Exact count of satisfying assignments by exhaustive enumeration. */
export function countSolutions(clauses: Clause[], n: number): number {
  let live = Array.from({ length: 1 << n }, (_, i) => i);
  for (const clause of clauses) {
    live = live.filter((mask) => satisfiesMask(clause, mask));
    if (live.length === 0) return 0;
  }
  return live.length;
}

const TIER_VARS: Record<number, number> = { 4: 8, 5: 12, 6: 14 };

function build(tier: number, seed: number) {
  const r = rng(mixSeed(`sat:t${tier}`, seed));
  const n = TIER_VARS[tier];
  const vars = Array.from({ length: n }, (_, i) => i);
  const target = vars.map(() => r.int(2));
  const targetMask = target.reduce((m, bit, v) => m | (bit << v), 0);
  let live = Array.from({ length: 1 << n }, (_, i) => i);
  const clauses: Clause[] = [];
  const seen = new Set<string>();
  for (let guard = 0; live.length > 1; guard++) {
    if (guard > 4_000) throw new Error(`sat: could not isolate a unique assignment for seed ${seed}`);
    // Greedy: sample clauses the target satisfies (any polarity pattern with at
    // least one literal true under the target), keep the one cutting the most
    // survivors. Mixed polarity is required: a mask differing in fewer than three
    // positions cannot be excluded by an all-target-polarity clause.
    const candidates: { clause: Clause; key: string; survivors: number }[] = [];
    for (let k = 0; k < 12; k++) {
      const vs = r.shuffle(vars.slice()).slice(0, 3);
      if (new Set(vs).size !== 3) continue;
      const clause = vs.map((v) => (v << 1) | r.int(2)).sort((a, b) => a - b) as Clause;
      const key = clause.join(",");
      if (seen.has(key) || !satisfiesMask(clause, targetMask)) continue;
      candidates.push({ clause, key, survivors: live.reduce((acc, mask) => acc + (satisfiesMask(clause, mask) ? 1 : 0), 0) });
    }
    // Targeted killer: for a random non-target survivor, build a clause that
    // excludes it — differing variables at target polarity (all false under the
    // victim, at least one true under the target), or one differing variable at
    // target polarity plus two agreeing variables at flipped polarity. This
    // guarantees progress every iteration.
    const others = live.filter((m) => m !== targetMask);
    const victim = others[r.int(others.length)];
    const diff = vars.filter((v) => ((victim >> v) & 1) !== target[v]);
    const same = vars.filter((v) => ((victim >> v) & 1) === target[v]);
    const killer: Clause = diff.length >= 3
      ? r.shuffle(diff.slice()).slice(0, 3).map((v) => (v << 1) | target[v]).sort((a, b) => a - b) as Clause
      : ([r.pick(diff), ...r.shuffle(same.slice()).slice(0, 2)] as number[]).map((v, i) => (v << 1) | (i === 0 ? target[v] : 1 - target[v])).sort((a, b) => a - b) as Clause;
    const killerKey = killer.join(",");
    if (!seen.has(killerKey)) {
      candidates.push({ clause: killer, key: killerKey, survivors: live.reduce((acc, mask) => acc + (satisfiesMask(killer, mask) ? 1 : 0), 0) });
    }
    const best = candidates.filter((c) => c.survivors < live.length).sort((a, b) => a.survivors - b.survivors)[0];
    if (!best) continue;
    seen.add(best.key);
    clauses.push(best.clause);
    live = live.filter((mask) => satisfiesMask(best.clause, mask));
  }
  if (live[0] !== targetMask || countSolutions(clauses, n) !== 1) throw new Error(`sat: generation failed for seed ${seed}`);
  const ordered = r.shuffle(clauses.slice());
  const text = ordered.map((c) => `(${c.map((lit) => `${(lit & 1) ? "" : "¬"}x${lit >> 1}`).join(" ∨ ")})`).join(" ∧\n");
  return {
    family: "sat" as const,
    tier,
    seed,
    prompt: `The following Boolean formula has exactly one satisfying assignment over variables x0 through x${n - 1}. Each parenthesized clause is an OR of three literals; ∧ is AND, ∨ is OR, ¬ is NOT.\n\n${text}\n\nReply with only the ${n}-digit assignment as bits, in order x0 first through x${n - 1} last.`,
    answer: target.join(""),
  };
}

/**
 * Tiers 4-6: unique planted 3-SAT assignments. Clauses are drawn only from
 * those the planted assignment satisfies, then filtered greedily until the
 * candidate list holds exactly one mask. n = 8, 12, 14 variables.
 */
export const sat: Family = {
  name: "sat",
  tiers: [4, 5, 6],
  generate: build,
};
