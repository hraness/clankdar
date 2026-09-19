import { expect, test } from "bun:test";
import { solveSession } from "../cloudflare/examples/model-solver.ts";
import type { Adapter } from "./adapter.ts";

test("hosted model example sends only public puzzles and enforces explicit model, token, request and deadline bounds", async () => {
  const start = Date.now();
  let clock = start;
  const input = {
    state: "issued", expiresAt: new Date(start + 20_000).toISOString(), privateKey: "must-not-forward",
    challenges: [
      { challengeId: "att_one", family: "arithmetic", tier: 2, prompt: "Return 7.", seed: 42, answer: "7", subject: "private-subject" },
      { challengeId: "att_two", family: "strings", tier: 2, prompt: "Return abc.", seed: 43, answer: "abc" },
    ],
  };
  type Options = Parameters<typeof import("./adapters.ts").openai>[0];
  let configured: Options | undefined;
  const received: unknown[] = [];
  const factory = (options: Options): Adapter => {
    configured = options;
    return { name: "fake-http", async solve(puzzle, context) {
      options.beforeRequest?.();
      received.push(puzzle);
      expect(context?.signal.aborted).toBe(false);
      return puzzle.family === "arithmetic" ? "7" : { text: "abc", finishReason: "length" };
    } };
  };
  const env = { MODEL: "chosen-model", OPENAI_API_KEY: "private-provider-key", OPENAI_BASE_URL: "https://provider.example/v1", MAX_TOKENS: "512", CLANKDAR_API_KEY: "wrong-key" };
  expect(await solveSession(input, env, factory, () => clock)).toEqual({ att_one: "7", att_two: "" });
  expect(received).toEqual([
    { family: "arithmetic", tier: 2, prompt: "Return 7." },
    { family: "strings", tier: 2, prompt: "Return abc." },
  ]);
  expect(configured).toMatchObject({ model: "chosen-model", apiKey: "private-provider-key", baseUrl: "https://provider.example/v1", maxTokens: 512, timeoutMs: 19_000 });
  // Two attempts already consumed; negotiation cannot create a thirteenth HTTP request.
  for (let i = 0; i < 10; i++) configured!.beforeRequest!();
  expect(() => configured!.beforeRequest!()).toThrow("request_limit");
  let constructions = 0;
  const unused = (): Adapter => { constructions++; throw new Error("unexpected transport"); };
  await expect(solveSession(input, { ...env, MODEL: undefined }, unused)).rejects.toThrow("MODEL is required");
  await expect(solveSession(input, { ...env, OPENAI_API_KEY: undefined }, unused)).rejects.toThrow("OPENAI_API_KEY is required");
  await expect(solveSession(input, { ...env, MAX_TOKENS: "4097" }, unused)).rejects.toThrow("MAX_TOKENS");
  await expect(solveSession({ ...input, challenges: Array(5).fill(input.challenges[0]) }, env, unused)).rejects.toThrow("1..4 challenges");
  await expect(solveSession({ ...input, expiresAt: new Date(start).toISOString() }, env, unused, () => clock)).rejects.toThrow("deadline");
  expect(constructions).toBe(0);
  await expect(solveSession(input, env, () => ({ name: "advancing-clock", async solve() { clock += 20_000; return "7"; } }), () => clock)).rejects.toThrow("deadline");
});
