import type { Family } from "../family.ts";
import { rng, type Rng } from "../rng.ts";

type Grid = number[][];

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

/**
 * Tiers 5-6: ARC-style grid transforms. Two example input/output pairs
 * demonstrate the rule; the subject applies it to a fresh grid. Tier 6
 * composes two transforms.
 */
export const gridxf: Family = {
  name: "gridxf",
  tiers: [5, 6],
  generate(tier, seed) {
    const r = rng(seed);
    const colors = 4;
    const names = ["rot90", "rot180", "flipH", "flipV", "transpose", "gravity", "crop"];
    const picked = r.shuffle(names.slice()).slice(0, tier === 6 ? 2 : 1);
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
    const pairs = train.map((g, i) => `Example ${i + 1} input:\n${render(g)}\nExample ${i + 1} output:\n${render(apply(g))}`).join("\n\n");
    const answer = render(apply(testGrid));
    return {
      family: this.name,
      tier,
      seed,
      prompt: `A hidden spatial rule transforms each grid (digits are colors, 0 is empty). Two examples:\n\n${pairs}\n\nApply the same rule to this input:\n${render(testGrid)}\n\nReply with only the output grid: digits separated by spaces, one row per line.`,
      answer,
    };
  },
};
