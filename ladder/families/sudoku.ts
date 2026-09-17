import type { Family } from "../family.ts";
import { rng } from "../rng.ts";

type Grid = number[][];

function candidates(grid: Grid, n: number, bw: number, bh: number, x: number, y: number): number[] {
  const used = new Set<number>();
  for (let i = 0; i < n; i++) { used.add(grid[y][i]); used.add(grid[i][x]); }
  const bx = Math.floor(x / bw) * bw, by = Math.floor(y / bh) * bh;
  for (let dy = 0; dy < bh; dy++) for (let dx = 0; dx < bw; dx++) used.add(grid[by + dy][bx + dx]);
  const out: number[] = [];
  for (let v = 1; v <= n; v++) if (!used.has(v)) out.push(v);
  return out;
}

function fill(grid: Grid, n: number, bw: number, bh: number, r: ReturnType<typeof rng>): boolean {
  let x = -1, y = -1;
  for (let yy = 0; yy < n && x < 0; yy++)
    for (let xx = 0; xx < n; xx++) if (grid[yy][xx] === 0) { x = xx; y = yy; break; }
  if (x < 0) return true;
  for (const v of r.shuffle(candidates(grid, n, bw, bh, x, y))) {
    grid[y][x] = v;
    if (fill(grid, n, bw, bh, r)) return true;
  }
  grid[y][x] = 0;
  return false;
}

function countSolutions(grid: Grid, n: number, bw: number, bh: number, cap: number): number {
  let x = -1, y = -1, best: number[] = [];
  for (let yy = 0; yy < n; yy++)
    for (let xx = 0; xx < n; xx++)
      if (grid[yy][xx] === 0) {
        const c = candidates(grid, n, bw, bh, xx, yy);
        if (c.length === 0) return 0;
        if (x < 0 || c.length < best.length) { x = xx; y = yy; best = c; }
      }
  if (x < 0) return 1;
  let count = 0;
  for (const v of best) {
    grid[y][x] = v;
    count += countSolutions(grid, n, bw, bh, cap - count);
    if (count >= cap) { grid[y][x] = 0; return count; }
  }
  grid[y][x] = 0;
  return count;
}

const TIER_PARAMS: Record<number, { n: number; bw: number; bh: number; clues: number }> = {
  3: { n: 4, bw: 2, bh: 2, clues: 7 },
  4: { n: 6, bw: 3, bh: 2, clues: 12 },
  5: { n: 9, bw: 3, bh: 3, clues: 30 },
};

/** Tiers 3-5: sudoku at 4x4, 6x6, 9x9. Puzzles are verified uniquely solvable. */
export const sudoku: Family = {
  name: "sudoku",
  tiers: [3, 4, 5],
  generate(tier, seed) {
    const r = rng(seed);
    const { n, bw, bh, clues } = TIER_PARAMS[tier];
    for (let attempt = 0; attempt < 60; attempt++) {
      const solved: Grid = Array.from({ length: n }, () => Array<number>(n).fill(0));
      fill(solved, n, bw, bh, r);
      const puzzle = solved.map((row) => row.slice());
      // Remove clues in random order, keeping the solution unique.
      const cells = r.shuffle([...Array(n * n).keys()]);
      let remaining = n * n;
      for (const c of cells) {
        if (remaining <= clues) break;
        const x = c % n, y = Math.floor(c / n);
        const keep = puzzle[y][x];
        puzzle[y][x] = 0;
        if (countSolutions(puzzle.map((row) => row.slice()), n, bw, bh, 2) !== 1) {
          puzzle[y][x] = keep;
        } else remaining--;
      }
      if (remaining > clues + 2) continue; // under-removed; try a fresh grid
      const drawn = puzzle.map((row) => row.map((v) => (v === 0 ? "." : String(v))).join(" ")).join("\n");
      const answer = solved.map((row) => row.join(" ")).join(" / ");
      return {
        family: this.name,
        tier,
        seed,
        prompt: `Solve this ${n}x${n} sudoku (each row, column, and ${bw}x${bh} box holds ${1}-${n} exactly once):\n\n${drawn}\n\nReply with only the completed grid: each row's digits separated by spaces, rows separated by " / ".`,
        answer,
      };
    }
    throw new Error(`sudoku: no unique puzzle for seed ${seed} tier ${tier}`);
  },
};

export const _internals = { countSolutions, candidates };
