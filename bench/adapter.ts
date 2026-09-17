import type { Puzzle, ToolEnv } from "../ladder/family.ts";

export interface SolveResponse {
  text: string;
  refused?: boolean;
  finishReason?: string;
  resolvedModel?: string;
  usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; costUsd?: number };
  parameters?: { tokenField: string; maxTokens: number; temperature: number | null; requests: number };
  /** Agent episodes: recorded tool/model transcript, call counts, and stop reason. */
  transcript?: unknown;
  toolCalls?: number;
  turns?: number;
  episodeError?: string;
}

/** Anything that can attempt a public puzzle: a model, a bot, a human UI, or a test double. */
export interface Adapter {
  readonly name: string;
  readonly config?: Readonly<Record<string, string | number | null>>;
  validate?(): void;
  solve(puzzle: Puzzle, context?: { signal: AbortSignal }): Promise<string | SolveResponse>;
  /**
   * Optional bounded tool-agent episode. The runner supplies the instance's
   * server-side tool environment; the model sees only text. Present only on
   * adapters built for the agent suite.
   */
  agent?(puzzle: Puzzle, env: ToolEnv | undefined, context?: { signal: AbortSignal }): Promise<SolveResponse>;
}

export interface BenchResult {
  type: "result";
  schemaVersion: 2;
  runId: string;
  suiteVersion: string;
  suiteHash: string;
  scorerVersion: string;
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
   * Diagnostic: the independently extracted final answer block matches.
   * This is not a capability estimate and never changes the strict verdict.
   * Extraction may miss correct answers formatted outside its grammar.
   */
  finalAnswerMatch: boolean;
  latencyMs: number;
  truncated?: boolean;
  refused?: boolean;
  detail?: Omit<SolveResponse, "text">;
  error?: string;
}

export interface CellSummary {
  n: number;
  attempted: number;
  passed: number;
  errors: number;
  rate: number | null;
  interval95: [number, number] | null;
  finalAnswerMatches: number;
}

export interface BenchSummary extends CellSummary {
  adapter: string;
  total: number;
  coverage: number;
  byTier: Record<number, CellSummary>;
  byFamily: Record<string, CellSummary>;
  byCell: Record<string, CellSummary>;
  bySeed: Record<number, CellSummary>;
}

export type AdapterErrorCode = "missing_api_key" | "http_error" | "invalid_response" | "response_too_large" | "parameter_negotiation" | "request_limit";

export class AdapterError extends Error {
  constructor(readonly code: AdapterErrorCode, readonly status?: number) {
    super(status === undefined ? code : `${code}:${status}`);
  }
}
