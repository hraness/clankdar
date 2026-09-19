#!/usr/bin/env bun
/** Opt-in HTTP solver for `bun actor run`; requires the operator's model and provider key. */
import { openai } from "../../bench/adapters.ts";
import { AdapterError, type Adapter } from "../../bench/adapter.ts";
import type { Puzzle } from "../../ladder/family.ts";

const MAX_INPUT_BYTES = 1_048_576;
const MAX_CHALLENGES = 4;
const MAX_REQUESTS = MAX_CHALLENGES * 3; // Includes the transport's rejected-parameter negotiation.
type Environment = Record<string, string | undefined>;
type AdapterFactory = (options: Parameters<typeof openai>[0]) => Adapter;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Injecting the transport and clock keeps the boundary test independent of a provider. */
export async function solveSession(input: unknown, env: Environment, makeAdapter: AdapterFactory = openai, now = Date.now): Promise<Record<string, string>> {
  if (!env.MODEL?.trim()) throw new Error("MODEL is required; choose the provider model explicitly");
  if (!env.OPENAI_API_KEY?.trim()) throw new Error("OPENAI_API_KEY is required");
  const tokenText = env.MAX_TOKENS ?? "512";
  const maxTokens = Number(tokenText);
  if (!/^\d+$/.test(tokenText) || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) throw new Error("MAX_TOKENS must be 1..4096");
  if (!object(input) || input.state !== "issued" || typeof input.expiresAt !== "string" || !Array.isArray(input.challenges) || input.challenges.length < 1 || input.challenges.length > MAX_CHALLENGES) throw new Error("expected one issued session with 1..4 challenges");
  const ids = new Set<string>();
  const challenges = input.challenges.map((value): { id: string; puzzle: Puzzle } => {
    if (!object(value) || typeof value.challengeId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.challengeId) || ids.has(value.challengeId) || typeof value.family !== "string" || !/^[a-z0-9]{1,64}$/.test(value.family) || !Number.isSafeInteger(value.tier) || (value.tier as number) < 0 || (value.tier as number) > 100 || typeof value.prompt !== "string" || !value.prompt || Buffer.byteLength(value.prompt) > 65_536) throw new Error("malformed public challenge");
    ids.add(value.challengeId);
    // Deliberately copy the public puzzle fields; never forward seeds, answers, or session/key metadata.
    return { id: value.challengeId, puzzle: { family: value.family, tier: value.tier as number, prompt: value.prompt } };
  });
  const deadline = Date.parse(input.expiresAt) - 1000; // Leave time for the actor client to sign and submit.
  const remaining = Math.min(120_000, deadline - now());
  if (!Number.isFinite(remaining) || remaining < 1) throw new Error("session deadline has passed");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  let requests = 0;
  try {
    const adapter = makeAdapter({
      model: env.MODEL.trim(), apiKey: env.OPENAI_API_KEY,
      // Pass an explicit endpoint so unrelated CLANKDAR_* ambient settings cannot choose the provider.
      baseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      maxTokens, timeoutMs: remaining,
      beforeRequest() {
        controller.signal.throwIfAborted();
        if (now() >= deadline) throw new Error("session deadline has passed");
        if (++requests > MAX_REQUESTS) throw new AdapterError("request_limit");
      },
    });
    adapter.validate?.();
    const responses: Record<string, string> = Object.create(null);
    for (const { id, puzzle } of challenges) {
      controller.signal.throwIfAborted();
      if (now() >= deadline) throw new Error("session deadline has passed");
      const result = await adapter.solve(puzzle, { signal: controller.signal });
      const answer = typeof result === "string" ? result : result.refused || result.finishReason === "length" ? "" : result.text;
      if (typeof answer !== "string" || Buffer.byteLength(answer) > 65_536) throw new Error("model response exceeds the response limit");
      responses[id] = answer;
    }
    controller.signal.throwIfAborted();
    if (now() >= deadline) throw new Error("session deadline has passed");
    return responses;
  } finally { clearTimeout(timer); }
}

async function readInput(): Promise<unknown> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_INPUT_BYTES) { await reader.cancel(); throw new Error("session input exceeds 1 MiB"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await solveSession(await readInput(), process.env))); }
  catch { console.error("Model solver failed. Check MODEL, provider credentials, endpoint, token limit, and session deadline. Provider details were not printed."); process.exitCode = 2; }
}
