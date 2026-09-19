import { AdapterError, type Adapter, type SolveResponse } from "./adapter.ts";
import { runEpisode, type TranscriptEntry } from "./agent.ts";

/** Privileged test control: the runner supplies the canonical answer without calling a model. */
export const oracle: Adapter = {
  name: "oracle",
  solve: async () => { throw new Error("the oracle is a runner-only test control"); },
};

/** Lower bound: echoes the prompt back. Should fail everything except trivial cases. */
export const echoAdapter: Adapter = {
  name: "echo",
  solve: async (puzzle) => puzzle.prompt,
};

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

async function boundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new AdapterError("invalid_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_048_576) {
        await reader.cancel();
        throw new AdapterError("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface CliOpts {
  model: string;
  timeoutMs?: number;
  /** Binary path override; defaults to resolving the program name on PATH. */
  bin?: string;
  /** Display name for results; defaults to `cli:<program>:<model>`. */
  name?: string;
  beforeRequest?: () => void;
}

interface CliProgram {
  bin: string;
  argv(prompt: string, model: string): string[];
  parse(stdout: string): SolveResponse;
}

const cliObject = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const cliTokens = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

const CLI_PROGRAMS: Record<string, CliProgram> = {
  // One text turn with every built-in and MCP tool disabled: the model sees the
  // prompt and can only answer in text, which is what the unaided tracks claim.
  claude: {
    bin: "claude",
    argv: (prompt, model) => ["-p", prompt, "--tools", "", "--strict-mcp-config", "--model", model, "--output-format", "json"],
    parse(stdout) {
      let decoded: unknown;
      try { decoded = JSON.parse(stdout); } catch { throw new AdapterError("invalid_response"); }
      const data = cliObject(decoded);
      if (data.is_error === true) throw new AdapterError("http_error", typeof data.api_error_status === "number" ? data.api_error_status : undefined);
      if (typeof data.result !== "string") throw new AdapterError("invalid_response");
      const usage = cliObject(data.modelUsage);
      // Several entries can appear (router/system overhead); the solving model
      // is the one that produced the completion tokens.
      let solver: Record<string, unknown> = {};
      let best = -1;
      for (const entry of Object.values(usage)) {
        const u = cliObject(entry);
        if (cliTokens(u.outputTokens) > best) { best = cliTokens(u.outputTokens); solver = u; }
      }
      return {
        text: data.result,
        finishReason: typeof data.subtype === "string" ? data.subtype.slice(0, 64) : undefined,
        resolvedModel: typeof solver.canonicalModel === "string" ? solver.canonicalModel.slice(0, 200) : undefined,
        usage: {
          inputTokens: cliTokens(solver.inputTokens) + cliTokens(solver.cacheReadInputTokens) + cliTokens(solver.cacheCreationInputTokens) || undefined,
          outputTokens: cliTokens(solver.outputTokens) || undefined,
          reasoningTokens: cliTokens(solver.thinkingTokens) || undefined,
          costUsd: typeof data.total_cost_usd === "number" && Number.isFinite(data.total_cost_usd) && data.total_cost_usd >= 0 ? data.total_cost_usd : undefined,
        },
        parameters: { tokenField: "maxOutputTokens", maxTokens: cliTokens(solver.maxOutputTokens), temperature: null, requests: 1 },
      };
    },
  },
};

async function boundedProc(stream: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > cap) {
        await reader.cancel();
        throw new AdapterError("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Local model-CLI adapter. Spawns the pinned program as a direct child (no
 * shell), one process per instance, with a bounded stdout and a timeout that
 * kills the process. Stderr is drained and discarded: provider error text
 * never enters recorded results.
 */
export function cli(program: string, opts: CliOpts): Adapter {
  const entry = CLI_PROGRAMS[program];
  if (!entry) throw new Error(`unknown cli program "${program}"`);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(opts.model)) throw new Error("invalid model ID");
  const timeoutMs = opts.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("timeoutMs must be an integer in 1..600000");
  return {
    name: opts.name ?? `cli:${program}:${opts.model}`,
    config: { program, model: opts.model, tools: "none", timeoutMs },
    validate() { if (!opts.bin && !Bun.which(entry.bin)) throw new Error(`cli program "${entry.bin}" not found on PATH`); },
    async solve(puzzle, context): Promise<SolveResponse> {
      const bin = opts.bin ?? Bun.which(entry.bin);
      if (!bin) throw new Error(`cli program "${entry.bin}" not found on PATH`);
      const signal = context ? AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const proc = Bun.spawn([bin, ...entry.argv(puzzle.prompt, opts.model)], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const kill = () => { try { proc.kill(); } catch { /* already exited */ } };
      try {
        opts.beforeRequest?.();
        // Orphaned grandchildren can hold the pipes after the child is killed,
        // so the abort races the reads instead of waiting for pipe EOF.
        const outcome = await Promise.race([
          Promise.all([boundedProc(proc.stdout, 1_048_576), boundedProc(proc.stderr, 65_536).catch(() => "")]).then(([stdout]) => ({ stdout })),
          new Promise<{ aborted: true }>((resolve) => signal.addEventListener("abort", () => { kill(); resolve({ aborted: true }); }, { once: true })),
        ]);
        kill();
        if (!("stdout" in outcome)) signal.throwIfAborted();
        const exitCode = await proc.exited;
        if (exitCode !== 0) throw new AdapterError("http_error", exitCode);
        return entry.parse((outcome as { stdout: string }).stdout);
      } finally {
        kill();
      }
    },
  };
}

interface ChatOpts {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Display name for results; defaults to `openai:<model>`. */
  name?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  beforeRequest?: () => void;
}

type ChatMessage = { role: string; content: string };

/** Shared bounded OpenAI-compatible transport with parameter negotiation. */
function chatTransport(opts: ChatOpts): {
  name: string;
  config: Readonly<Record<string, string | number | null>>;
  validate(): void;
  chat(messages: ChatMessage[], context?: { signal: AbortSignal }): Promise<SolveResponse>;
} {
  if (!/^[a-z0-9][a-z0-9_./:-]{0,199}$/i.test(opts.model)) throw new Error("invalid model ID");
  let url: URL;
  try { url = new URL(opts.baseUrl ?? process.env.CLANKDAR_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"); } catch { throw new Error("invalid endpoint URL"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw new Error("endpoint must use HTTPS (or loopback HTTP) without credentials, query, or fragment");
  const baseUrl = url.href.replace(/\/$/, "");
  const apiKey = opts.apiKey ?? process.env.CLANKDAR_API_KEY ?? process.env.OPENAI_API_KEY;
  const name = opts.name ?? `openai:${opts.model}`;
  const maxTokens = opts.maxTokens ?? 4096;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const temperature = opts.temperature ?? 0;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32_768) throw new Error("maxTokens must be an integer in 1..32768");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("timeoutMs must be an integer in 1..600000");
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error("temperature must be in 0..2");
  // Reasoning families reject `temperature` and `max_tokens`; negotiate only
  // explicit rejected parameters and record the actual shape for every response.
  let sendTemp = true;
  let tokField = "max_tokens";
  const validate = () => { if (!apiKey && !local) throw new AdapterError("missing_api_key"); };
  return {
    name,
    config: { model: opts.model, endpoint: baseUrl, maxTokens, temperature, timeoutMs },
    validate,
    async chat(messages, context): Promise<SolveResponse> {
      validate();
      const signal = context ? AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const body = {
          model: opts.model, [tokField]: maxTokens,
          ...(sendTemp ? { temperature } : {}),
          messages,
        };
        opts.beforeRequest?.();
        const res = await (opts.fetch ?? fetch)(`${baseUrl}/chat/completions`, {
          method: "POST", redirect: "error",
          headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify(body), signal,
        });
        const text = await boundedBody(res);
        if (!res.ok) {
          if (res.status === 400 && /temperature/i.test(text) && "temperature" in body) { sendTemp = false; continue; }
          if (res.status === 400 && /max_tokens|max_completion_tokens/i.test(text) && "max_tokens" in body) { tokField = "max_completion_tokens"; continue; }
          throw new AdapterError("http_error", res.status);
        }
        let decoded: unknown;
        try { decoded = JSON.parse(text); } catch { throw new AdapterError("invalid_response"); }
        const data = object(decoded);
        const choice = object(Array.isArray(data.choices) ? data.choices[0] : undefined);
        const message = object(choice.message);
        const refused = typeof message.refusal === "string" || choice.finish_reason === "content_filter";
        const content = typeof message.content === "string" ? message.content : refused ? "" : null;
        if (content === null || (apiKey && apiKey.length >= 8 && text.includes(apiKey))) throw new AdapterError("invalid_response");
        const usage = object(data.usage);
        const tokens = object(usage.completion_tokens_details);
        return {
          text: content,
          refused,
          finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason.slice(0, 64) : undefined,
          resolvedModel: typeof data.model === "string" ? data.model.slice(0, 200) : undefined,
          usage: {
            inputTokens: count(usage.prompt_tokens), outputTokens: count(usage.completion_tokens), reasoningTokens: count(tokens.reasoning_tokens),
            costUsd: typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : undefined,
          },
          parameters: { tokenField: "max_tokens" in body ? "max_tokens" : "max_completion_tokens", maxTokens, temperature: "temperature" in body ? temperature : null, requests: attempt + 1 },
        };
      }
      throw new AdapterError("parameter_negotiation");
    },
  };
}

/** OpenAI-compatible chat-completions adapter with bounded transport and recorded parameters. */
export function openai(opts: ChatOpts): Adapter {
  const t = chatTransport(opts);
  return {
    name: t.name,
    config: t.config,
    validate: t.validate,
    solve: (puzzle, context) => t.chat([{ role: "user", content: puzzle.prompt }], context),
  };
}

export const AGENT_PROTOCOL_VERSION = "clankdar-agent-protocol-v1";

/**
 * Bounded tool-agent adapter: the model plays the TOOL/FINAL protocol against
 * the runner-side deterministic environment. Usage and parameters aggregate
 * across turns; the full transcript is returned for replay verification.
 */
export function openaiAgent(opts: ChatOpts): Adapter {
  const t = chatTransport({ ...opts, name: opts.name ?? `agent:openai:${opts.model}` });
  return {
    name: t.name,
    config: { ...t.config, protocol: AGENT_PROTOCOL_VERSION },
    validate: t.validate,
    solve: (puzzle, context) => t.chat([{ role: "user", content: puzzle.prompt }], context),
    async agent(puzzle, env, context): Promise<SolveResponse> {
      t.validate();
      const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 };
      let requests = 0;
      let parameters: SolveResponse["parameters"];
      let resolvedModel: string | undefined;
      let finishReason: string | undefined;
      const step = async (history: { role: "user" | "assistant"; text: string }[], ctx?: { signal: AbortSignal }) => {
        const r = await t.chat(history.map((h) => ({ role: h.role, content: h.text })), ctx ?? context);
        requests += r.parameters?.requests ?? 1;
        parameters = r.parameters ? { ...r.parameters, requests } : parameters;
        resolvedModel = r.resolvedModel ?? resolvedModel;
        finishReason = r.finishReason ?? finishReason;
        usage.inputTokens += r.usage?.inputTokens ?? 0;
        usage.outputTokens += r.usage?.outputTokens ?? 0;
        usage.reasoningTokens += r.usage?.reasoningTokens ?? 0;
        usage.costUsd += r.usage?.costUsd ?? 0;
        return r.text;
      };
      const episode = await runEpisode(
        step,
        { family: puzzle.family, tier: puzzle.tier, seed: -1, prompt: puzzle.prompt, answer: "", env },
        undefined,
        context,
      );
      const lastModel = [...episode.transcript].reverse().find((e) => e.role === "model");
      return {
        text: episode.finalAnswer ?? lastModel?.text ?? "",
        finishReason,
        resolvedModel,
        usage: { ...usage, costUsd: usage.costUsd || undefined },
        parameters,
        transcript: episode.transcript as TranscriptEntry[],
        toolCalls: episode.calls,
        turns: episode.turns,
        episodeError: episode.error,
      };
    },
  };
}

export function adapterByName(spec: string): Adapter {
  if (spec === "oracle") return oracle;
  if (spec === "echo") return echoAdapter;
  if (spec.startsWith("agent:openai:")) return openaiAgent({ model: spec.slice(13) });
  if (spec.startsWith("openai:")) return openai({ model: spec.slice(7) });
  if (spec.startsWith("cli:")) {
    const rest = spec.slice(4);
    const sep = rest.indexOf(":");
    if (sep < 1) throw new Error(`cli adapters need a program and model (cli:<program>:<model>)`);
    return cli(rest.slice(0, sep), { model: rest.slice(sep + 1) });
  }
  throw new Error(`unknown adapter "${spec}" (expected oracle | echo | openai:<model> | agent:openai:<model> | cli:<program>:<model>)`);
}
