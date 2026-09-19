export const SCORER_VERSION = "clankdar-score-v2";
export const MAX_ANSWER_LENGTH = 65_536;
export type AnswerFormat = "text" | "integer" | "grid" | "bits" | "tokens" | "assignments";

/** Deterministic server-side tools for agent-mode instances; never sent to model adapters. */
export interface ToolEnv {
  tools: Record<string, (args: unknown) => string>;
  budget?: { maxCalls?: number; maxTurns?: number; maxOutput?: number };
}

/** A single generated puzzle instance. `answer` is the canonical truth. */
export interface Instance {
  family: string;
  tier: number;
  seed: number;
  prompt: string;
  answer: string;
  env?: ToolEnv;
}

export type Puzzle = Readonly<Pick<Instance, "family" | "tier" | "prompt">>;

/** A parameterized puzzle family. Tiers select difficulty parameters. */
export interface Family {
  readonly name: string;
  /** Tiers this family supports. */
  readonly tiers: readonly number[];
  generate(tier: number, seed: number): Instance;
}

export function answerFormat(family: string): AnswerFormat {
  if (["arithmetic", "sequence", "gridpath", "registervm", "cryptarithm", "relayvm", "algal"].includes(family)) return "integer";
  if (["sudoku", "gridxf"].includes(family)) return "grid";
  if (["automata", "sat", "satcheck", "bitmatrix", "bitcircuit", "autostep"].includes(family)) return "bits";
  if (family === "ordering") return "tokens";
  if (family === "knights") return "assignments";
  return "text";
}

/** Canonicalize text whitespace without deleting signs, punctuation, case, or token boundaries. */
export function normalize(answer: string): string {
  return answer.trim().replace(/\s+/g, " ");
}

export function canonicalAnswer(answer: unknown, format: AnswerFormat = "text"): string | null {
  if (typeof answer !== "string" || answer.length > MAX_ANSWER_LENGTH || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(answer)) return null;
  const text = answer.trim();
  if (!text) return null;
  if (format === "text") return normalize(text);
  if (format === "integer") return /^[+-]?\d+$/.test(text) ? BigInt(text).toString() : null;
  if (format === "bits") return /^[01]+$/.test(text) ? text : null;
  if (format === "tokens") return /^[a-z](?:[\s,]+[a-z])*$/i.test(text) ? text.toUpperCase().split(/[\s,]+/).join(" ") : null;
  if (format === "assignments") {
    const value = text.toLowerCase().replace(/\s*=\s*/g, "=");
    if (!/^[a-z]=(knight|knave)(?:[\s,]+[a-z]=(knight|knave))*$/.test(value)) return null;
    const parts = value.split(/[\s,]+/);
    return new Set(parts.map((part) => part[0])).size === parts.length ? parts.join(" ") : null;
  }
  if (format === "grid") {
    const rows = text.replace(/\r\n?/g, "\n").split(/\s*\/\s*|\n/).map((row) => row.trim());
    if (!rows.every((row) => /^[0-9](?:[ \t]+[0-9])*$/.test(row))) return null;
    const grid = rows.map((row) => row.split(/[ \t]+/));
    return grid.every((row) => row.length === grid[0].length) ? JSON.stringify(grid) : null;
  }
  return null;
}

export function answersMatch(expected: string, got: string, format: AnswerFormat = "text"): boolean {
  const canonical = canonicalAnswer(expected, format);
  return canonical !== null && canonical === canonicalAnswer(got, format);
}

export function extractFinalAnswer(response: string, format: AnswerFormat): string {
  if (response.length > MAX_ANSWER_LENGTH) return "";
  const lines = response.trim().replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1)?.trim() === "```") {
    lines.pop();
    const start = lines.findLastIndex((line) => /^```(?:[a-z]+)?\s*$/i.test(line.trim()));
    if (start >= 0) return lines.slice(start + 1).join("\n").trim();
    return "";
  }
  if (format === "grid") {
    const tail: string[] = [];
    while (lines.length && /^[\d \t/]+$/.test(lines.at(-1)!)) tail.unshift(lines.pop()!);
    return tail.join("\n");
  }
  return (lines.at(-1) ?? "").trim().replace(/^(?:final answer|answer)\s*:\s*/i, "").replace(/^\*\*(.+)\*\*$/, "$1").replace(/^`([^`]+)`$/, "$1");
}

export function scoreAnswer(expected: string, response: string, format: AnswerFormat = "text") {
  const pass = answersMatch(expected, response, format);
  const finalAnswerMatch = pass || answersMatch(expected, extractFinalAnswer(response, format), format);
  return { pass, finalAnswerMatch, formatOnly: !pass && finalAnswerMatch };
}
