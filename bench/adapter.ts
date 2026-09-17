import type { Instance } from "../ladder/family.ts";

/** Anything that can attempt a puzzle instance: a model, a bot, a human UI, or a test double. */
export interface Adapter {
  readonly name: string;
  solve(inst: Instance): Promise<string>;
}

export interface BenchResult {
  adapter: string;
  family: string;
  tier: number;
  seed: number;
  prompt: string;
  expected: string;
  response: string;
  pass: boolean;
  latencyMs: number;
  error?: string;
}

export interface CellSummary {
  n: number;
  passed: number;
  rate: number;
}

export interface BenchSummary {
  adapter: string;
  total: number;
  passed: number;
  errors: number;
  rate: number;
  byTier: Record<number, CellSummary>;
  byFamily: Record<string, CellSummary>;
}
