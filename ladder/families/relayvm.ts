import type { Family, ToolEnv } from "../family.ts";
import { rng, mixSeed, type Rng } from "../rng.ts";

const OPS = ["mov", "add", "sub", "mul", "xor", "shl"] as const;
const NREG = 4;

function evalOp(regs: number[], op: string): boolean {
  const m = op.match(/^(mov|add|sub|mul|xor|shl) r(\d) (r\d|\d+)$/);
  if (!m || Number(m[2]) >= NREG) return false;
  const i = Number(m[2]);
  const vb = m[3].startsWith("r") ? (Number(m[3][1]) < NREG ? regs[Number(m[3][1])] : NaN) : Number(m[3]);
  if (!Number.isFinite(vb)) return false;
  const va = regs[i];
  const v = m[1] === "mov" ? vb : m[1] === "add" ? va + vb : m[1] === "sub" ? va - vb : m[1] === "mul" ? va * vb : m[1] === "xor" ? va ^ vb : va << vb;
  regs[i] = v & 0xffff;
  return true;
}

function runLines(lines: string[], regs: number[]): number[] | null {
  const state = regs.slice(0, NREG);
  while (state.length < NREG) state.push(0);
  for (const line of lines) if (!evalOp(state, line)) return null;
  return state;
}

function program(r: Rng, len: number): { lines: string[]; regs: number[] } {
  const regs = new Array<number>(NREG).fill(0);
  const lines: string[] = [`mov r0 ${r.intBetween(1, 9)}`];
  evalOp(regs, lines[0]);
  for (let i = 1; i < len; i++) {
    const op = r.pick(OPS);
    const a = r.int(NREG);
    if (op === "mov") { lines.push(`mov r${a} ${r.intBetween(1, 30)}`); }
    else if (op === "shl") { lines.push(`shl r${a} ${r.intBetween(1, 3)}`); }
    else { lines.push(`${op} r${a} r${r.int(NREG)}`); }
    if (!evalOp(regs, lines[i])) { i--; lines.pop(); continue; }
  }
  return { lines, regs };
}

const PROTOCOL = `You are being evaluated as a tool-using agent. On each turn reply with exactly ONE line in one of these forms:
TOOL <name> <json-object-args>
FINAL <answer>
Available tools:
- vm_state {"k": <int>} returns the register vector [r0,r1,r2,r3] of the ORIGINAL program after its first k instructions.
- vm_run {"lines": [<op>, ...], "regs": [<int>, ...]} runs the given ops starting from regs (optional, default all zero) and returns the final register vector. Op format matches the listing: mov/add/sub/mul/xor/shl, registers r0-r3, 16-bit wrapping.
You may make at most 6 tool calls.`;

const TIER_LEN: Record<number, number> = { 5: 12, 6: 16 };

function build(tier: number, seed: number) {
  const r = rng(mixSeed(`relayvm:t${tier}`, seed));
  const len = TIER_LEN[tier];
  const { lines } = program(r, len);
  const k = r.intBetween(2, len - 3);
  const replacement = (() => {
    const op = r.pick(OPS);
    const a = r.int(NREG);
    if (op === "mov") return `mov r${a} ${r.intBetween(1, 30)}`;
    if (op === "shl") return `shl r${a} ${r.intBetween(1, 3)}`;
    return `${op} r${a} r${r.int(NREG)}`;
  })();
  const modified = lines.slice();
  modified[k] = replacement;
  const out = runLines(modified, [0, 0, 0, 0]);
  if (!out) throw new Error("relayvm: generated program is invalid");
  const listing = lines.map((l, i) => `${i}: ${l}`).join("\n");
  const env: ToolEnv = {
    budget: { maxCalls: 6, maxTurns: 10 },
    tools: {
      vm_state(args) {
        const kk = (args as { k?: unknown }).k;
        if (!Number.isInteger(kk) || (kk as number) < 0 || (kk as number) > len) throw new Error("bad k");
        return JSON.stringify(runLines(lines.slice(0, kk as number), [0, 0, 0, 0]));
      },
      vm_run(args) {
        const a = args as { lines?: unknown; regs?: unknown };
        if (!Array.isArray(a.lines) || a.lines.length > 64 || a.lines.some((l) => typeof l !== "string" || (l as string).length > 64)) throw new Error("bad lines");
        if (a.regs !== undefined && (!Array.isArray(a.regs) || a.regs.length > NREG || a.regs.some((v) => !Number.isInteger(v)))) throw new Error("bad regs");
        const result = runLines(a.lines as string[], (a.regs as number[] | undefined) ?? [0, 0, 0, 0]);
        if (!result) throw new Error("invalid program");
        return JSON.stringify(result);
      },
    },
  };
  return {
    family: "relayvm" as const,
    tier,
    seed,
    prompt: `${PROTOCOL}\n\nProgram:\n\n${listing}\n\nIf line ${k} were changed to "${replacement}", what would r0 be after the last instruction? `,
    answer: String(out[0]),
    env,
  };
}

/** Agent pool: counterfactual register-VM execution via bounded tools. */
export const relayvm: Family = {
  name: "relayvm",
  tiers: [5, 6],
  generate: build,
};

export const _internals = { runLines, evalOp };
