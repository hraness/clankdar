import type { Adapter } from "./adapter.ts";
import type { Instance } from "../ladder/family.ts";

/** Upper bound: always returns the canonical answer. Validates the harness end-to-end. */
export const oracle: Adapter = {
  name: "oracle",
  solve: async (inst) => inst.answer,
};

/** Lower bound: echoes the prompt back. Should fail everything except trivial cases. */
export const echoAdapter: Adapter = {
  name: "echo",
  solve: async (inst) => inst.prompt,
};

/** OpenAI-compatible chat-completions adapter. Works against any conforming endpoint. */
export function openai(opts: {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Display name for results; defaults to `openai:<model>`. */
  name?: string;
}): Adapter {
  const baseUrl = (opts.baseUrl ?? process.env.CLANKDAR_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const apiKey = opts.apiKey ?? process.env.CLANKDAR_API_KEY ?? process.env.OPENAI_API_KEY;
  const name = opts.name ?? `openai:${opts.model}`;
  // Reasoning families reject `temperature` and `max_tokens`; negotiate the
  // accepted parameter shape once, on the first 400, and reuse it.
  let sendTemp = true;
  let tokField = "max_tokens";
  const buildBody = (prompt: string) => {
    const body: Record<string, unknown> = {
      model: opts.model,
      [tokField]: opts.maxTokens ?? 4096,
      messages: [{ role: "user", content: prompt }],
    };
    if (sendTemp) body.temperature = opts.temperature ?? 0;
    return body;
  };
  return {
    name,
    async solve(inst: Instance): Promise<string> {
      if (!apiKey) throw new Error("openai adapter: no API key (set OPENAI_API_KEY or CLANKDAR_API_KEY)");
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(buildBody(inst.prompt)),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
        });
        if (res.ok) {
          const data = await res.json();
          const content = data?.choices?.[0]?.message?.content;
          if (typeof content !== "string") throw new Error("openai adapter: no message content in response");
          return content;
        }
        const text = (await res.text()).slice(0, 300);
        if (res.status === 400 && /temperature/i.test(text) && sendTemp) {
          sendTemp = false;
          continue;
        }
        if (res.status === 400 && /max_tokens|max_completion_tokens/i.test(text) && tokField === "max_tokens") {
          tokField = "max_completion_tokens";
          continue;
        }
        throw new Error(`openai adapter: HTTP ${res.status} ${text}`);
      }
      throw new Error("openai adapter: parameter negotiation failed");
    },
  };
}

export function adapterByName(spec: string): Adapter {
  if (spec === "oracle") return oracle;
  if (spec === "echo") return echoAdapter;
  if (spec.startsWith("openai:")) return openai({ model: spec.slice(7) });
  throw new Error(`unknown adapter "${spec}" (expected oracle | echo | openai:<model>)`);
}
