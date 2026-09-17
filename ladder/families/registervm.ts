import type { Family } from "../family.ts";
import { rng } from "../rng.ts";

const OPS = ["mov", "add", "sub", "mul", "xor", "shl"] as const;

/** Tiers 3-4: simulate a tiny register machine; report the final r0. */
export const registervm: Family = {
  name: "registervm",
  tiers: [3, 4],
  generate(tier, seed) {
    const r = rng(seed);
    const regs = [0, 0, 0];
    const lines: string[] = [];
    const len = tier === 3 ? 5 : 8;
    regs[0] = r.intBetween(1, 9);
    lines.push(`mov r0 ${regs[0]}`);
    for (let i = 1; i < len; i++) {
      const op = r.pick(OPS);
      const a = r.int(3);
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
        const b = r.int(3);
        const va = regs[a], vb = regs[b];
        if (op === "add") emit(`add r${a} r${b}`, va + vb);
        else if (op === "sub") emit(`sub r${a} r${b}`, va - vb);
        else if (op === "xor") emit(`xor r${a} r${b}`, va ^ vb);
        else if (va !== 0 && va * vb < 5000) emit(`mul r${a} r${b}`, va * vb);
        else { i--; continue; } // avoid runaway values; redraw
      }
    }
    const listing = lines.map((l, i) => `${i}: ${l}`).join("\n");
    return {
      family: this.name,
      tier,
      seed,
      prompt: `A tiny machine has registers r0, r1, r2 starting at 0. Run this program top to bottom:\n\n${listing}\n\nOps: mov rx k sets rx to k; add/sub/mul/xor rx ry combine into rx; shl rx k shifts rx left by k bits. All values are unsigned 16-bit (every result wraps modulo 65536). What is r0 after the last instruction? Reply with only the integer.`,
      answer: String(regs[0]),
    };
  },
};
