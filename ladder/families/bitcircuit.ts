import type { Family } from "../family.ts";
import { rng, mixSeed } from "../rng.ts";

export type Gate = { op: "and" | "or" | "xor" | "nand" | "not" | "buf"; a: number; b?: number };

function evaluate(inputs: number[], gates: Gate[]): number[] {
  const wires = inputs.slice();
  for (const g of gates) {
    const a = wires[g.a];
    const b = g.b === undefined ? 0 : wires[g.b];
    wires.push(
      g.op === "and" ? a & b
      : g.op === "or" ? a | b
      : g.op === "xor" ? a ^ b
      : g.op === "nand" ? 1 - (a & b)
      : g.op === "not" ? 1 - a
      : a,
    );
  }
  return wires;
}

const TIER_DEPTH: Record<number, number> = { 4: 12, 5: 20, 6: 32 };

function build(tier: number, seed: number) {
  const r = rng(mixSeed(`bitcircuit:t${tier}`, seed));
  const inputs = r.intBetween(6, 8);
  const depth = TIER_DEPTH[tier];
  const inBits = Array.from({ length: inputs }, () => r.int(2));
  const gates: Gate[] = [];
  for (let i = 0; i < depth; i++) {
    const maxWire = inputs + i;
    const op = r.pick(["and", "or", "xor", "nand", "not", "buf"] as const);
    const a = r.int(maxWire);
    const b = op === "not" || op === "buf" ? undefined : r.int(maxWire);
    gates.push({ op, a, b });
  }
  const listing = gates.map((g, i) => {
    const w = inputs + i;
    return g.b === undefined ? `w${w} = ${g.op.toUpperCase()}(w${g.a})` : `w${w} = ${g.op.toUpperCase()}(w${g.a}, w${g.b})`;
  }).join("\n");
  const wires = evaluate(inBits, gates);
  const out = wires.slice(-8);
  const lo = wires.length - 8;
  return {
    family: "bitcircuit" as const,
    tier,
    seed,
    prompt: `A Boolean circuit takes inputs w0..w${inputs - 1} = ${inBits.join("")} (w0 is the first digit). Wires are numbered; each line defines the next wire. AND/OR/XOR/NAND are the usual binary gates; NOT inverts one wire; BUF copies it.\n\n${listing}\n\nReply with only the values of w${lo} through w${wires.length - 1} as 8 bits in wire order.`,
    answer: out.join(""),
  };
}

/**
 * Tiers 4-6: evaluate a deep acyclic Boolean circuit and report the last
 * eight wires, an 8-bit answer (depth 12, 20, 32 gates).
 */
export const bitcircuit: Family = {
  name: "bitcircuit",
  tiers: [4, 5, 6],
  generate: build,
};

export const _internals = { evaluate };
