import type { Family } from "../family.ts";
import { rng, mixSeed } from "../rng.ts";

const OPS = ["mov", "add", "sub", "mul", "xor", "shl"] as const;

const TIER_PARAMS: Record<number, { regs: number; len: number }> = {
  3: { regs: 3, len: 5 },
  4: { regs: 3, len: 8 },
  5: { regs: 4, len: 12 },
  6: { regs: 4, len: 16 },
};

function build(tier: number, seed: number) {
  const r = rng(seed);
  const { regs: nregs, len } = TIER_PARAMS[tier];
  const regs = new Array<number>(nregs).fill(0);
  const lines: string[] = [];
  regs[0] = r.intBetween(1, 9);
  lines.push(`mov r0 ${regs[0]}`);
  for (let i = 1; i < len; i++) {
    const op = r.pick(OPS);
    const a = r.int(nregs);
    const emit = (text: string, value: number) => {
      regs[a] = value & 0xffff;
      lines.push(text);
    };
    if (op === "mov") {
      const v = r.intBetween(1, 30);
      emit(`mov r${a} ${v}`, v);
    } else if (op === "shl") {
      const k = r.intBetween(1, 3);
      emit(`shl r${a} ${k}`, regs[a] << k);
    } else {
      const b = r.int(nregs);
      const va = regs[a], vb = regs[b];
      if (op === "add") emit(`add r${a} r${b}`, va + vb);
      else if (op === "sub") emit(`sub r${a} r${b}`, va - vb);
      else if (op === "xor") emit(`xor r${a} r${b}`, va ^ vb);
      else if (va !== 0 && va * vb < 5000) emit(`mul r${a} r${b}`, va * vb);
      else { i--; continue; } // avoid runaway values; redraw
    }
  }
  const names = Array.from({ length: nregs }, (_, i) => `r${i}`).join(", ");
  const listing = lines.map((l, i) => `${i}: ${l}`).join("\n");
  return {
    family: "registervm" as const,
    tier,
    seed,
    prompt: `A tiny machine has registers ${names} starting at 0. Run this program top to bottom:\n\n${listing}\n\nOps: mov rx k sets rx to k; add/sub/mul/xor rx ry combine into rx; shl rx k shifts rx left by k bits. All values are unsigned 16-bit (every result wraps modulo 65536). What is r0 after the last instruction? Reply with only the integer.`,
    answer: String(regs[0]),
  };
}

/** Tiers 3-4: simulate a tiny 3-register machine; report the final r0. */
export const registervm: Family = {
  name: "registervm",
  tiers: [3, 4],
  generate: build,
};

/** Frontier pool: tiers 5-6 add a fourth register and longer programs. */
export const registervmDeep: Family = {
  name: "registervm",
  tiers: [5, 6],
  generate: (tier, seed) => ({ ...build(tier, mixSeed(`registervm:t${tier}`, seed)), seed }),
};
