/** Deterministic Mulberry32 for public benchmark seeds; not a cryptographic RNG. */

export type Rng = {
  next(): number;
  int(maxExclusive: number): number;
  intBetween(lo: number, hi: number): number;
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: T[]): T[];
  chance(p: number): boolean;
};

/** FNV-1a mix of a label into a seed: decorrelates streams across cells that share a seed. */
export function mixSeed(label: string, seed: number): number {
  let h = 0x811c9dc5;
  for (const c of label) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193); }
  return (seed ^ h) >>> 0;
}

export function rng(seed: number): Rng {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("seed must be a uint32 integer");
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max) => Math.floor(next() * max),
    intBetween: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      return items;
    },
    chance: (p) => next() < p,
  };
}
