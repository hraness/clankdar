import type { Family } from "../family.ts";
import { rng, mixSeed, type Rng } from "../rng.ts";

export type Grid = number[][];

function randGrid(r: Rng, w: number, h: number, colors: number, density: number): Grid {
  return Array.from({ length: h }, () =>
    Array.from({ length: w }, () => (r.chance(density) ? r.intBetween(1, colors) : 0)),
  );
}

const OPS: Record<string, (g: Grid) => Grid> = {
  rot90: (g) => g[0].map((_, x) => g.map((row) => row[x]).reverse()),
  rot180: (g) => g.map((row) => row.slice().reverse()).reverse(),
  flipH: (g) => g.slice().reverse(),
  flipV: (g) => g.map((row) => row.slice().reverse()),
  transpose: (g) => g[0].map((_, x) => g.map((row) => row[x])),
  gravity: (g) => {
    const h = g.length, w = g[0].length;
    const out = Array.from({ length: h }, () => Array<number>(w).fill(0));
    for (let x = 0; x < w; x++) {
      const cells = g.map((row) => row[x]).filter((v) => v !== 0);
      for (let i = 0; i < cells.length; i++) out[h - cells.length + i][x] = cells[i];
    }
    return out;
  },
  tile2: (g) => g.flatMap((row) => [row.concat(row), row.concat(row)]),
  crop: (g) => {
    let y0 = g.length, y1 = -1, x0 = g[0].length, x1 = -1;
    g.forEach((row, y) => row.forEach((v, x) => {
      if (v !== 0) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    }));
    if (y1 < 0) return [[0]];
    return g.slice(y0, y1 + 1).map((row) => row.slice(x0, x1 + 1));
  },
};

function recolor(a: number, b: number) {
  return (g: Grid) => g.map((row) => row.map((v) => (v === a ? b : v === b ? a : v)));
}

const render = (g: Grid) => g.map((row) => row.join(" ")).join("\n");
const NAMES = ["rot90", "rot180", "flipH", "flipV", "transpose", "gravity", "crop"];

export function gridCandidates(tier: number): ((grid: Grid) => Grid)[] {
  const chains = tier === 5
    ? NAMES.map((name) => [name])
    : tier === 6
      ? NAMES.flatMap((a) => NAMES.filter((b) => b !== a).map((b) => [a, b]))
      : NAMES.flatMap((a) => NAMES.filter((b) => b !== a).flatMap((b) => NAMES.filter((c) => c !== a && c !== b).map((c) => [a, b, c])));
  return [false, true].flatMap((swap) => chains.map((chain) => (grid: Grid) => chain.reduce((g, name) => OPS[name](g), swap ? recolor(1, 2)(grid) : grid)));
}

export const transformGrid = (name: string, grid: Grid): Grid => OPS[name](grid);

function build(tier: number, seed: number) {
  const r = rng(seed);
  const colors = 4;
  const chainLen = tier === 5 ? 1 : tier === 6 ? 2 : 3;
  const picked = r.shuffle(NAMES.slice()).slice(0, chainLen);
  const swap = r.chance(0.3) ? recolor(1, 2) : null;
  const apply = (g: Grid) => {
    let out = g;
    if (swap) out = swap(out);
    for (const name of picked) out = OPS[name](out);
    return out;
  };
  const w = r.intBetween(3, 5), h = r.intBetween(3, 5);
  const density = 0.45;
  const train = [randGrid(r, w, h, colors, density), randGrid(r, w, h, colors, density)];
  const testGrid = randGrid(r, w, h, colors, density);
  let remaining = gridCandidates(tier).filter((rule) => train.every((g) => render(rule(g)) === render(apply(g))));
  while (new Set(remaining.map((rule) => render(rule(testGrid)))).size > 1 && train.length < 14) {
    const example = randGrid(r, w, h, colors, density);
    train.push(example);
    remaining = remaining.filter((rule) => render(rule(example)) === render(apply(example)));
  }
  if (!remaining.length || new Set(remaining.map((rule) => render(rule(testGrid)))).size !== 1) throw new Error("gridxf: ambiguous query");
  const pairs = train.map((g, i) => `Example ${i + 1} input:\n${render(g)}\nExample ${i + 1} output:\n${render(apply(g))}`).join("\n\n");
  const answer = render(apply(testGrid));
  const ops = tier === 5 ? "one operation" : tier === 6 ? "two different operations in order" : "three different operations in order";
  return {
    family: "gridxf" as const,
    tier,
    seed,
    prompt: `A hidden spatial rule transforms each grid (digits are colors, 0 is empty). First, optionally swap colors 1 and 2. Then apply ${ops} from: rotate clockwise 90 degrees; rotate 180 degrees; reverse row order; reverse column order; transpose; gravity (move nonzero cells down within each column, preserving order); crop to the bounding rectangle of nonzero cells (all empty becomes a single 0). Examples:\n\n${pairs}\n\nApply the same rule to this input:\n${render(testGrid)}\n\nReply with only the output grid: digits separated by spaces, one row per line.`,
    answer,
  };
}

/**
 * Tiers 5-6: bounded grid transforms. At least two input/output pairs
 * disambiguate the query within the stated rule grammar. Tier 6
 * composes two transforms.
 */
export const gridxf: Family = {
  name: "gridxf",
  tiers: [5, 6],
  generate: build,
};

/** Frontier pool: tier 7 composes three transforms. */
export const gridxfDeep: Family = {
  name: "gridxf",
  tiers: [7],
  generate: (tier, seed) => ({ ...build(tier, mixSeed(`gridxf:t${tier}`, seed)), seed }),
};
