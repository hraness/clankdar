import type { Family } from "../family.ts";
import { rng } from "../rng.ts";

type Grid = string[][];

function bfs(grid: Grid, w: number, h: number): number {
  const dist = Array.from({ length: h }, () => Array<number>(w).fill(-1));
  dist[0][0] = 0;
  const q: [number, number][] = [[0, 0]];
  while (q.length) {
    const [x, y] = q.shift()!;
    if (x === w - 1 && y === h - 1) return dist[y][x];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && grid[ny][nx] !== "#" && dist[ny][nx] < 0) {
        dist[ny][nx] = dist[y][x] + 1;
        q.push([nx, ny]);
      }
    }
  }
  return -1;
}

/** Tier 3: shortest path through an obstacle grid, from corner to corner. */
export const gridpath: Family = {
  name: "gridpath",
  tiers: [3],
  generate(tier, seed) {
    const r = rng(seed);
    const w = 6, h = 6;
    for (let attempt = 0; attempt < 200; attempt++) {
      const grid: Grid = Array.from({ length: h }, () => Array<string>(w).fill("."));
      // Carve a guaranteed monotone path first, then scatter obstacles off it.
      const path = new Set<string>(["0,0"]);
      let x = 0, y = 0;
      while (x !== w - 1 || y !== h - 1) {
        if (x < w - 1 && (y === h - 1 || r.chance(0.55))) x++;
        else y++;
        path.add(`${x},${y}`);
      }
      let placed = 0;
      const target = r.intBetween(7, 10);
      while (placed < target) {
        const ox = r.int(w), oy = r.int(h);
        if (!path.has(`${ox},${oy}`) && grid[oy][ox] !== "#") {
          grid[oy][ox] = "#";
          placed++;
        }
      }
      const shortest = bfs(grid, w, h);
      if (shortest < 0) continue;
      // Require the path to be interesting: strictly longer than Manhattan.
      if (shortest === w - 1 + h - 1 && r.chance(0.7)) continue;
      grid[0][0] = "S";
      grid[h - 1][w - 1] = "G";
      const drawn = grid.map((row) => row.join("")).join("\n");
      return {
        family: this.name,
        tier,
        seed,
        prompt: `In this grid, S is the start, G is the goal, # is a wall, . is open floor. Moves are up/down/left/right (no diagonals).\n\n${drawn}\n\nHow many moves does the shortest path from S to G take? Reply with only the number.`,
        answer: String(shortest),
      };
    }
    throw new Error(`gridpath: no solvable grid for seed ${seed}`);
  },
};
