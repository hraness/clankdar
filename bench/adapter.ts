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
  /** Strict verdict: normalized response equals normalized answer. */
  pass: boolean;
  /**
   * Diagnostic: the normalized response ends with the normalized answer —
   * i.e. the model solved it but wrapped the answer in prose. Strict `pass`
   * remains the contract verdict; this separates capability from format-
   * following. Conservative: misses correct answers buried mid-response.
   */
  answerPresent?: boolean;
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
