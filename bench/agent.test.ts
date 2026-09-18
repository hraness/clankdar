import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AGENT_FAMILIES } from "../ladder/mod.ts";
import type { Adapter } from "./adapter.ts";
import { oracle } from "./adapters.ts";
import { runBench } from "./run.ts";
import { recordRun, runManifest } from "./record.ts";
import { parseAction, replayEpisode, runEpisode, type AgentStep } from "./agent.ts";
import { replayRun } from "./replay.ts";

const family = (name: string) => AGENT_FAMILIES.find((f) => f.name === name)!;

/** Scripted solver: chains ca_step calls to walk the automaton, then FINAL. */
const autostepScript = (prompt: string): AgentStep => {
  const m = prompt.match(/rule (\d+)\. Starting row is:\n\n([01]+)\n\nAfter exactly (\d+)/)!;
  const rule = Number(m[1]);
  let row = m[2];
  let left = Number(m[3]);
  return async (history) => {
    const last = [...history].reverse().find((h) => h.role === "user" && h.text.startsWith("RESULT ca_step:"));
    if (last) row = last.text.slice("RESULT ca_step: ".length);
    if (left-- > 0) return `TOOL ca_step {"rule":${rule},"row":"${row}"}`;
    return `FINAL ${row}`;
  };
};

/** Scripted solver: splices the replacement line and runs the whole program via vm_run. */
const relayvmScript = (prompt: string): AgentStep => {
  const m = prompt.match(/Program:\n\n([\s\S]+?)\n\nIf line (\d+) were changed to "([^"]+)"/)!;
  const lines = m[1].split("\n").map((l) => l.replace(/^\d+: /, ""));
  lines[Number(m[2])] = m[3];
  let called = false;
  return async (history) => {
    if (!called) {
      called = true;
      return `TOOL vm_run {"lines":${JSON.stringify(lines)}}`;
    }
    const last = [...history].reverse().find((h) => h.text.startsWith("RESULT vm_run:"))!;
    return `FINAL ${JSON.parse(last.text.slice("RESULT vm_run: ".length))[0]}`;
  };
};

/** Scripted solver: brute-forces the formula locally, verifies via check, then FINAL. */
const satcheckScript = (prompt: string): AgentStep => {
  const n = Number(prompt.match(/x0 through x(\d+)/)![1]) + 1;
  const clauses = [...prompt.matchAll(/\(([^)]+)\)/g)].map((m) =>
    m[1].split(" ∨ ").map((t) => (Number(t.replace("¬", "").slice(1)) << 1) | (t.startsWith("¬") ? 0 : 1)),
  );
  let mask = 0;
  for (; mask < 1 << n; mask++) {
    if (clauses.every((c) => c.some((lit) => ((mask >> (lit >> 1)) & 1) === (lit & 1)))) break;
  }
  const bits = Array.from({ length: n }, (_, i) => (mask >> i) & 1).join("");
  let called = false;
  return async (history) => {
    const last = history[history.length - 1];
    if (called) {
      if (!last.text.includes("satisfies")) throw new Error("check should satisfy the unique assignment");
      return `FINAL ${bits}`;
    }
    called = true;
    return `TOOL check {"bits":"${bits}"}`;
  };
};

describe("agent protocol", () => {
  test("parseAction accepts exactly one action line", () => {
    expect(parseAction("FINAL 42")).toEqual({ kind: "final", answer: "42" });
    expect(parseAction("  \nFINAL  0110\n")).toEqual({ kind: "final", answer: "0110" });
    expect(parseAction('TOOL ca_step {"rule":30,"row":"01"}')).toEqual({ kind: "tool", name: "ca_step", args: { rule: 30, row: "01" } });
    for (const bad of ["", "hello", "TOOL", "FINAL", "FINAL   ", 'TOOL x not-json', 'TOOL x [1,2]', 'TOOL x null', "tool x {}", "Let me think\nFINAL 1"]) {
      expect(parseAction(bad).kind).toBe("invalid");
    }
  });

  test("a scripted agent solves autostep through real tools and replays exactly", async () => {
    const inst = family("autostep").generate(5, 301);
    const episode = await runEpisode(autostepScript(inst.prompt), inst);
    expect(episode.error).toBeUndefined();
    expect(episode.finalAnswer).toBe(inst.answer);
    expect(episode.calls).toBe(5);
    expect(episode.transcript.filter((e) => e.role === "tool" && e.ok)).toHaveLength(5);
    expect(replayEpisode(inst, episode.transcript)).toBe(true);
  });

  test("a scripted agent solves relayvm with one composed vm_run call", async () => {
    const inst = family("relayvm").generate(5, 302);
    const episode = await runEpisode(relayvmScript(inst.prompt), inst);
    expect(episode.finalAnswer).toBe(inst.answer);
    expect(episode.calls).toBe(1);
    expect(replayEpisode(inst, episode.transcript)).toBe(true);
  });

  test("a scripted agent verifies the satcheck assignment through check", async () => {
    const inst = family("satcheck").generate(5, 303);
    const episode = await runEpisode(satcheckScript(inst.prompt), inst);
    expect(episode.finalAnswer).toBe(inst.answer);
    expect(episode.calls).toBe(1);
    expect(replayEpisode(inst, episode.transcript)).toBe(true);
  });

  test("episodes are deterministic across repeated runs", async () => {
    const inst = family("autostep").generate(6, 304);
    const a = await runEpisode(autostepScript(inst.prompt), inst);
    const b = await runEpisode(autostepScript(inst.prompt), inst);
    expect(a.transcript).toEqual(b.transcript);
    expect(a.finalAnswer).toBe(b.finalAnswer);
  });

  test("malformed replies and unknown tools are recorded, not fatal", async () => {
    const inst = family("autostep").generate(5, 305);
    const inner = autostepScript(inst.prompt);
    let stage = 0;
    const episode = await runEpisode(async (history) => {
      if (stage === 0) { stage++; return "I am narrating instead of acting"; }
      if (stage === 1) { stage++; return "TOOL nope {}"; }
      return inner(history);
    }, inst);
    const entries = episode.transcript.filter((e) => e.role === "tool" && !e.ok);
    expect(entries.some((e) => e.tool === "protocol")).toBe(true);
    expect(entries.some((e) => e.text === "unknown_tool nope")).toBe(true);
    expect(episode.finalAnswer).toBe(inst.answer);
  });

  test("the call budget is a hard cap but FINAL still lands", async () => {
    const inst = family("autostep").generate(5, 306);
    const inner = autostepScript(inst.prompt);
    // Budget is steps+2 = 7; burn all 7 on one extra cycle then answer late.
    const episode = await runEpisode(async (history) => {
      const calls = history.filter((h) => h.text.startsWith("RESULT ca_step:")).length;
      if (calls < 7) return `TOOL ca_step {"rule":30,"row":"01010101010101010"}`;
      return inner(history);
    }, inst);
    const exhausted = episode.transcript.filter((e) => e.role === "tool" && e.text === "budget_exhausted");
    expect(exhausted.length).toBeGreaterThan(0);
    expect(episode.calls).toBe(7);
    // After the cap the scripted fallback keeps calling ca_step, which keeps
    // hitting the cap — so the FINAL never arrives within the turn budget.
    expect(episode.finalAnswer).toBeNull();
    expect(episode.error).toBe("budget_exhausted");
  });

  test("turn exhaustion ends the episode without a final answer", async () => {
    const inst = family("relayvm").generate(5, 307);
    const episode = await runEpisode(async () => "garbage", inst);
    expect(episode.finalAnswer).toBeNull();
    expect(episode.error).toBe("budget_exhausted");
    expect(episode.turns).toBe(10);
  });

  test("invalid tool arguments return a recorded error", async () => {
    const inst = family("autostep").generate(5, 308);
    const episode = await runEpisode(async (history) => {
      if (history.length === 1) return 'TOOL ca_step {"rule":30,"row":"not-bits"}';
      return "FINAL 0";
    }, inst);
    const tool = episode.transcript.find((e) => e.role === "tool");
    expect(tool?.ok).toBe(false);
    expect(tool?.text).toBe("invalid_arguments");
  });

  test("replay rejects tampered tool outputs and forged actions", async () => {
    const inst = family("autostep").generate(5, 309);
    const episode = await runEpisode(autostepScript(inst.prompt), inst);
    const tampered = episode.transcript.map((e, i) => i === 1 ? { ...e, text: e.text === "0" ? "1" : `${e.text.slice(1)}0` } : e);
    expect(replayEpisode(inst, tampered)).toBe(false);
    const forged = episode.transcript.map((e, i) => i === 0 ? { ...e, text: 'TOOL ca_step {"rule":90,"row":"0"}' } : e);
    expect(replayEpisode(inst, forged)).toBe(false);
  });
});

describe("agent bench integration", () => {
  const scriptedAdapter = (script: (prompt: string) => AgentStep): Adapter => ({
    name: "scripted",
    solve: async () => "unused",
    async agent(puzzle, env) {
      const episode = await runEpisode(script(puzzle.prompt), { family: puzzle.family, tier: puzzle.tier, seed: -1, prompt: puzzle.prompt, answer: "", env });
      return { text: episode.finalAnswer ?? "", transcript: episode.transcript, toolCalls: episode.calls, turns: episode.turns, episodeError: episode.error };
    },
  });

  test("runBench plays the protocol and records the transcript", async () => {
    const results = await runBench(scriptedAdapter(autostepScript), { suite: "agent", families: ["autostep"], tiers: [5], seeds: [401, 402] });
    expect(results).toHaveLength(2);
    for (const row of results) {
      expect(row.pass).toBe(true);
      expect(row.suiteVersion).toBe("clankdar-agent-v0");
      expect(row.seed).toBeGreaterThanOrEqual(401);
      const detail = row.detail as { transcript?: unknown[]; toolCalls?: number };
      expect(Array.isArray(detail.transcript)).toBe(true);
      expect(detail.toolCalls).toBe(5);
    }
  });

  test("oracle remains a runner control on the agent suite", async () => {
    const results = await runBench(oracle, { suite: "agent", families: ["relayvm"], tiers: [5], seeds: [403] });
    expect(results[0].pass).toBe(true);
    expect(results[0].detail?.transcript).toBeUndefined();
  });

  test("an unaided adapter on the agent suite gets one bare turn", async () => {
    const bare: Adapter = { name: "bare", solve: async () => "FINAL 1" };
    const results = await runBench(bare, { suite: "agent", families: ["satcheck"], tiers: [5], seeds: [404] });
    expect(results[0].pass).toBe(false);
    expect(results[0].detail?.transcript).toBeUndefined();
  });

  test("the manifest records the agent protocol version", () => {
    const manifest = runManifest(oracle, { suite: "agent", families: ["autostep"], tiers: [5], seeds: [405] });
    expect(manifest.protocol).toBe("clankdar-agent-protocol-v1");
    expect(manifest.suiteVersion).toBe("clankdar-agent-v0");
  });

  test("recorded agent runs rescore and replay through the file format", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clankdar-agent-"));
    const path = join(dir, "scripted.jsonl");
    await recordRun(scriptedAdapter(autostepScript), { suite: "agent", families: ["autostep"], tiers: [5], seeds: [406, 407] }, path);
    const outcomes = replayRun(path);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.replayed)).toBe(true);
  });
});
