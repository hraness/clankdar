import { AdapterError, type Adapter, type SolveResponse } from "./adapter.ts";

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

/** OpenAI-compatible chat-completions adapter with bounded transport and recorded parameters. */
export function openai(opts: {
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
}): Adapter {
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
    async solve(puzzle, context): Promise<SolveResponse> {
      validate();
      const signal = context ? AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const body = {
          model: opts.model, [tokField]: maxTokens,
          ...(sendTemp ? { temperature } : {}),
          messages: [{ role: "user", content: puzzle.prompt }],
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

export function adapterByName(spec: string): Adapter {
  if (spec === "oracle") return oracle;
  if (spec === "echo") return echoAdapter;
  if (spec.startsWith("openai:")) return openai({ model: spec.slice(7) });
  throw new Error(`unknown adapter "${spec}" (expected oracle | echo | openai:<model>)`);
}
