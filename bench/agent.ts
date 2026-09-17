import type { Instance, Puzzle, ToolEnv } from "../ladder/family.ts";

/**
 * Bounded tool-agent protocol.
 *
 * An agent-mode instance carries a server-side `env` of deterministic tools.
 * The model sees only the prompt (which documents the tools) and a growing
 * text transcript. Each turn it must emit exactly one action:
 *
 *   TOOL <name> <json-object-args>
 *   FINAL <answer>
 *
 * Tools are pure functions of (args, env) — no host shell, filesystem,
 * network, secrets, or ambient state. Call budgets are hard limits; the
 * transcript is fully replayable.
 */

export interface TranscriptEntry {
  turn: number;
  role: "model" | "tool";
  text: string;
  tool?: string;
  ok?: boolean;
}

export interface EpisodeBudget {
  /** Hard cap on tool calls. */
  maxCalls: number;
  /** Hard cap on model turns (calls + answers + malformed replies). */
  maxTurns: number;
  /** Per-tool-output character cap. */
  maxOutput: number;
}

export const DEFAULT_BUDGET: EpisodeBudget = { maxCalls: 16, maxTurns: 24, maxOutput: 4_096 };

export interface EpisodeResult {
  finalAnswer: string | null;
  transcript: TranscriptEntry[];
  calls: number;
  turns: number;
  error?: "budget_exhausted" | "protocol_error";
}

export interface AgentStep {
  (history: { role: "user" | "assistant"; text: string }[], ctx?: { signal: AbortSignal }): Promise<string>;
}

/** Parse one model reply into an action. Strict: one line, exact verbs. */
export function parseAction(reply: string): { kind: "tool"; name: string; args: unknown } | { kind: "final"; answer: string } | { kind: "invalid" } {
  const line = reply.trim().split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const tool = line.match(/^TOOL ([a-z][a-z0-9_]*) (.+)$/);
  if (tool) {
    let args: unknown;
    try { args = JSON.parse(tool[2]); } catch { return { kind: "invalid" }; }
    if (args === null || typeof args !== "object" || Array.isArray(args)) return { kind: "invalid" };
    return { kind: "tool", name: tool[1], args };
  }
  const fin = line.match(/^FINAL (.*)$/);
  if (fin && fin[1].trim().length > 0) return { kind: "final", answer: fin[1].trim() };
  return { kind: "invalid" };
}

/** Compose the model-visible transcript text from entries. */
export function transcriptText(transcript: TranscriptEntry[]): string {
  return transcript.map((e) => (e.role === "model" ? e.text : `RESULT ${e.tool}: ${e.ok ? e.text : `ERROR ${e.text}`}`)).join("\n");
}

/**
 * Run one bounded episode. `step` is the raw model call; tools execute
 * locally and deterministically. The episode ends on FINAL, a parse failure,
 * or budget exhaustion.
 */
export async function runEpisode(
  step: AgentStep,
  inst: Instance & { env?: ToolEnv },
  budgetOverride?: Partial<EpisodeBudget>,
  ctx?: { signal: AbortSignal },
): Promise<EpisodeResult> {
  const budget: EpisodeBudget = { ...DEFAULT_BUDGET, ...inst.env?.budget, ...budgetOverride };
  const tools = inst.env?.tools ?? {};
  const transcript: TranscriptEntry[] = [];
  const history: { role: "user" | "assistant"; text: string }[] = [{ role: "user", text: inst.prompt }];
  let calls = 0;
  for (let turn = 0; turn < budget.maxTurns; turn++) {
    const reply0 = await step(history, ctx);
    let reply = reply0;
    if (reply.length > 8_192) reply = reply.slice(0, 8_192);
    transcript.push({ turn, role: "model", text: reply });
    history.push({ role: "assistant", text: reply });
    const action = parseAction(reply);
    if (action.kind === "final") return { finalAnswer: action.answer, transcript, calls, turns: turn + 1 };
    if (action.kind === "invalid") {
      transcript.push({ turn, role: "tool", text: "protocol_error: emit exactly one 'TOOL <name> {json}' or 'FINAL <answer>' line", tool: "protocol", ok: false });
      history.push({ role: "user", text: "RESULT protocol: ERROR emit exactly one 'TOOL <name> {json}' or 'FINAL <answer>' line" });
      continue;
    }
    if (calls >= budget.maxCalls) {
      transcript.push({ turn, role: "tool", text: "budget_exhausted", tool: action.name, ok: false });
      history.push({ role: "user", text: `RESULT ${action.name}: ERROR budget_exhausted` });
      continue;
    }
    const fn = tools[action.name];
    calls++;
    let output: string;
    let ok = true;
    if (!fn) {
      output = `unknown_tool ${action.name}`;
      ok = false;
    } else {
      try {
        output = String(fn(action.args));
      } catch {
        output = "invalid_arguments";
        ok = false;
      }
    }
    if (output.length > budget.maxOutput) output = output.slice(0, budget.maxOutput) + "…";
    transcript.push({ turn, role: "tool", text: output, tool: action.name, ok });
    history.push({ role: "user", text: `RESULT ${action.name}: ${ok ? output : `ERROR ${output}`}` });
  }
  return { finalAnswer: null, transcript, calls, turns: budget.maxTurns, error: "budget_exhausted" };
}

/** Replay a transcript's tool calls against the env; verifies determinism. */
export function replayEpisode(inst: Instance & { env?: ToolEnv }, transcript: TranscriptEntry[]): boolean {
  const tools = inst.env?.tools ?? {};
  const maxOutput = inst.env?.budget?.maxOutput ?? DEFAULT_BUDGET.maxOutput;
  for (const entry of transcript) {
    if (entry.role !== "tool" || !entry.ok || !entry.tool || entry.tool === "protocol") continue;
    const model = transcript.find((m) => m.turn === entry.turn && m.role === "model");
    if (!model) return false;
    const action = parseAction(model.text);
    if (action.kind !== "tool" || action.name !== entry.tool) return false;
    const fn = tools[action.name];
    if (!fn) return false;
    let expected: string;
    try { expected = String(fn(action.args)); } catch { return false; }
    if (expected.length > maxOutput) expected = expected.slice(0, maxOutput) + "…";
    if (expected !== entry.text) return false;
  }
  return true;
}

export type AgentPuzzle = Puzzle;
