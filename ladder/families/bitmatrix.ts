import type { Family } from "../family.ts";
import { rng, mixSeed, type Rng } from "../rng.ts";

type Row = { mask: number; rhs: number };

function solve(rows: Row[], n: number): number[] | null {
  const m = rows.map((row) => ({ ...row }));
  let rank = 0;
  const pivots: number[] = [];
  for (let col = 0; col < n && rank < m.length; col++) {
    let p = m.findIndex((row, i) => i >= rank && ((row.mask >> col) & 1));
    if (p < 0) continue;
    [m[rank], m[p]] = [m[p], m[rank]];
    for (let i = 0; i < m.length; i++) {
      if (i !== rank && ((m[i].mask >> col) & 1)) { m[i].mask ^= m[rank].mask; m[i].rhs ^= m[rank].rhs; }
    }
    pivots.push(col);
    rank++;
  }
  for (const row of m) if (row.mask === 0 && row.rhs === 1) return null;
  if (rank < n) return null;
  const x = new Array<number>(n).fill(0);
  for (let i = 0; i < rank; i++) {
    const col = pivots[i];
    let bit = m[i].rhs;
    for (let c = 0; c < n; c++) if (c !== col && ((m[i].mask >> c) & 1)) bit ^= x[c];
    x[col] = bit;
  }
  return x;
}

function uniqueSystem(r: Rng, n: number, extra: number): { rows: Row[]; x: number[] } | null {
  const x = Array.from({ length: n }, () => r.int(2));
  const rows: Row[] = [];
  const used = new Set<number>();
  while (rows.length < n + extra) {
    const mask = r.int(1 << n);
    if (mask === 0 || used.has(mask)) continue;
    used.add(mask);
    let rhs = 0;
    for (let v = 0; v < n; v++) if ((mask >> v) & 1) rhs ^= x[v];
    rows.push({ mask, rhs });
  }
  const solved = solve(rows, n);
  return solved !== null && solved.join("") === x.join("") ? { rows, x } : null;
}

const TIER_SIZE: Record<number, { n: number; extra: number }> = {
  4: { n: 6, extra: 2 },
  5: { n: 9, extra: 3 },
  6: { n: 12, extra: 4 },
};

function build(tier: number, seed: number) {
  const r = rng(mixSeed(`bitmatrix:t${tier}`, seed));
  const { n, extra } = TIER_SIZE[tier];
  let sys: { rows: Row[]; x: number[] } | null = null;
  for (let attempt = 0; attempt < 400 && !sys; attempt++) sys = uniqueSystem(r, n, extra);
  if (!sys) throw new Error(`bitmatrix: no unique system for seed ${seed}`);
  const text = sys.rows.map((row) => {
    const terms: string[] = [];
    for (let v = 0; v < n; v++) if ((row.mask >> v) & 1) terms.push(`x${v}`);
    return `${terms.join(" ⊕ ")} = ${row.rhs}`;
  }).join("\n");
  return {
    family: "bitmatrix" as const,
    tier,
    seed,
    prompt: `Solve this system of linear equations over GF(2): every variable is 0 or 1 and ⊕ is XOR (addition modulo 2). The system has exactly one solution.\n\n${text}\n\nReply with only the ${n}-digit assignment as bits, in order x0 first through x${n - 1} last.`,
    answer: sys.x.join(""),
  };
}

/** Tiers 4-6: solve a GF(2) linear system with a unique solution; n = 6, 9, 12 variables. */
export const bitmatrix: Family = {
  name: "bitmatrix",
  tiers: [4, 5, 6],
  generate: build,
};

export const _internals = { solve };
