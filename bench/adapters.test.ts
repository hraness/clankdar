import { describe, expect, test } from "bun:test";
import { openai } from "./adapters.ts";
import { requestBudget } from "./options.ts";
import type { SolveResponse } from "./adapter.ts";

const puzzle = { family: "arithmetic", tier: 0, prompt: "What is 2 + 2? Reply with only the number." };
const success = () => Response.json({ model: "resolved-model", choices: [{ message: { content: "4" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 0 }, cost: 0.001 } });

function fixture(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return openai({ model: "test-model", baseUrl: "https://example.test/v1", apiKey: "synthetic-key", fetch: ((url, init) => Promise.resolve(handler(String(url), init!))) });
}

describe("model transport", () => {
  test("sends only the prompt and records usage and actual parameters", async () => {
    let request: RequestInit | undefined;
    let target = "";
    const adapter = fixture((url, init) => { target = url; request = init; return success(); });
    const result = await adapter.solve(puzzle) as SolveResponse;
    expect(target).toBe("https://example.test/v1/chat/completions");
    expect(request?.redirect).toBe("error");
    expect(JSON.parse(request!.body as string).messages).toEqual([{ role: "user", content: puzzle.prompt }]);
    expect(result.text).toBe("4");
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 2, reasoningTokens: 0, costUsd: 0.001 });
    expect(result.parameters).toEqual({ tokenField: "max_tokens", maxTokens: 4096, temperature: 0, requests: 1 });
    expect(JSON.stringify(adapter.config)).not.toContain("synthetic-key");
  });

  test("negotiates only rejected parameters and records the final shape", async () => {
    const bodies: Record<string, unknown>[] = [];
    const adapter = fixture((_, init) => {
      const body = JSON.parse(init.body as string);
      bodies.push(body);
      if (body.max_tokens) return Response.json({ error: { message: "Use max_completion_tokens instead of max_tokens" } }, { status: 400 });
      if (body.temperature !== undefined) return Response.json({ error: { message: "temperature unsupported" } }, { status: 400 });
      return success();
    });
    const result = await adapter.solve(puzzle) as SolveResponse;
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).not.toHaveProperty("temperature");
    expect(bodies[2]).toHaveProperty("max_completion_tokens", 4096);
    expect(result.parameters).toEqual({ tokenField: "max_completion_tokens", maxTokens: 4096, temperature: null, requests: 3 });
    const next = await adapter.solve(puzzle) as SolveResponse;
    expect(next.parameters?.requests).toBe(1);
  });

  test("HTTP errors are not retried or copied into result logs", async () => {
    let requests = 0;
    const adapter = fixture(() => { requests++; return Response.json({ error: { message: "private upstream detail synthetic-key" } }, { status: 503 }); });
    await expect(adapter.solve(puzzle)).rejects.toThrow("http_error:503");
    expect(requests).toBe(1);
  });

  test("malformed and oversized responses fail closed", async () => {
    await expect(fixture(() => Response.json({ choices: [{ message: { content: {} } }] })).solve(puzzle)).rejects.toThrow("invalid_response");
    await expect(fixture(() => new Response("not JSON")).solve(puzzle)).rejects.toThrow("invalid_response");
    await expect(fixture(() => new Response("x".repeat(1_048_577))).solve(puzzle)).rejects.toThrow("response_too_large");
  });

  test("explicit refusals are model outcomes, not provider errors", async () => {
    const result = await fixture(() => Response.json({ choices: [{ message: { content: null, refusal: "cannot answer" }, finish_reason: "stop" }] })).solve(puzzle) as SolveResponse;
    expect(result.refused).toBe(true);
    expect(result.text).toBe("");
  });

  test("reflected credentials cannot enter response records", async () => {
    await expect(fixture(() => Response.json({ choices: [{ message: { content: "synthetic-key" } }] })).solve(puzzle)).rejects.toThrow("invalid_response");
    expect(() => openai({ model: "model", baseUrl: "private-invalid-value" })).toThrow("invalid endpoint URL");
  });

  test("remote cleartext, embedded credentials, and unbounded settings are rejected", () => {
    for (const baseUrl of ["http://example.test/v1", "https://user:password@example.test/v1", "https://example.test/v1?key=secret", "https://example.test/v1#secret"]) {
      expect(() => openai({ model: "model", baseUrl })).toThrow();
    }
    expect(() => openai({ model: "model", maxTokens: Infinity })).toThrow();
    expect(() => openai({ model: "model", timeoutMs: 0 })).toThrow();
    expect(() => openai({ model: "model", temperature: NaN })).toThrow();
    expect(() => openai({ model: "" })).toThrow();
  });

  test("loopback endpoints support no-key local models", async () => {
    const adapter = openai({ model: "local", baseUrl: "http://127.0.0.1:8000/v1", apiKey: "", fetch: (() => Promise.resolve(success())) });
    expect((await adapter.solve(puzzle) as SolveResponse).text).toBe("4");
  });

  test("the global request budget includes parameter negotiation", async () => {
    const budget = requestBudget(1);
    const adapter = openai({ model: "test", apiKey: "synthetic", beforeRequest: budget.beforeRequest, fetch: (() => Promise.resolve(Response.json({ error: "temperature unsupported" }, { status: 400 }))) });
    await expect(adapter.solve(puzzle)).rejects.toThrow("request_limit");
    expect(budget.used()).toBe(1);
  });
});
