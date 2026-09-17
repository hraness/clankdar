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
}): Adapter {
  const baseUrl = (opts.baseUrl ?? process.env.BOTCAPTCHA_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const apiKey = opts.apiKey ?? process.env.BOTCAPTCHA_API_KEY ?? process.env.OPENAI_API_KEY;
  const name = `openai:${opts.model}`;
  return {
    name,
    async solve(inst: Instance): Promise<string> {
      if (!apiKey) throw new Error("openai adapter: no API key (set OPENAI_API_KEY or BOTCAPTCHA_API_KEY)");
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: opts.model,
          temperature: opts.temperature ?? 0,
          max_tokens: opts.maxTokens ?? 1024,
          messages: [{ role: "user", content: inst.prompt }],
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      if (!res.ok) throw new Error(`openai adapter: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("openai adapter: no message content in response");
      return content;
    },
  };
}

export function adapterByName(spec: string): Adapter {
  if (spec === "oracle") return oracle;
  if (spec === "echo") return echoAdapter;
  if (spec.startsWith("openai:")) return openai({ model: spec.slice(7) });
  throw new Error(`unknown adapter "${spec}" (expected oracle | echo | openai:<model>)`);
}
