import { AdapterError } from "./adapter.ts";
import type { BenchOptions } from "./run.ts";

export const commonOptions = {
  seeds: { type: "string" }, tiers: { type: "string" }, families: { type: "string" }, suite: { type: "string" },
  concurrency: { type: "string" }, "timeout-ms": { type: "string" }, "max-tokens": { type: "string" },
  "max-requests": { type: "string" }, out: { type: "string" },
  execute: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" },
} as const;

export function integer(value: string, max: number, min = 1): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`expected an integer in ${min}..${max}`);
  return Number(value);
}

export function list(spec: string, max = 1000): string[] {
  const parts = spec.split(",").map((part) => part.trim());
  if (!parts.length || parts.length > max || parts.some((part) => !part) || new Set(parts).size !== parts.length) throw new Error("list must contain distinct, nonempty values within its limit");
  return parts;
}

export function parseInts(spec: string, max = 0xffffffff): number[] {
  const out: number[] = [];
  for (const part of list(spec)) {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error("invalid integer list");
    const lo = integer(match[1], max, 0), hi = integer(match[2] ?? match[1], max, 0);
    if (lo > hi || out.length + hi - lo + 1 > 1000) throw new Error("range must be ascending and contain at most 1000 values");
    for (let n = lo; n <= hi; n++) out.push(n);
  }
  if (new Set(out).size !== out.length) throw new Error("duplicate values in range");
  return out.sort((a, b) => a - b);
}

export function selection(values: Record<string, string | boolean | undefined>): BenchOptions {
  const text = (key: string, fallback: string) => typeof values[key] === "string" ? values[key] as string : fallback;
  const suite = text("suite", "v2");
  if (suite !== "v2" && suite !== "frontier" && suite !== "agent") throw new Error("--suite must be v2, frontier, or agent");
  return {
    seeds: parseInts(text("seeds", "1-10")),
    tiers: values.tiers === undefined ? undefined : parseInts(text("tiers", ""), 8),
    families: values.families === undefined ? undefined : list(text("families", "")),
    suite,
    concurrency: integer(text("concurrency", "4"), 64),
    timeoutMs: integer(text("timeout-ms", "120000"), 600_000),
  };
}

export function requestBudget(limit: number): { beforeRequest: () => void; used: () => number } {
  if (!Number.isInteger(limit) || limit < 1 || limit > 30_000) throw new Error("request limit must be in 1..30000");
  let used = 0;
  return {
    used: () => used,
    beforeRequest: () => {
      if (used >= limit) throw new AdapterError("request_limit");
      used++;
    },
  };
}
