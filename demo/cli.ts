#!/usr/bin/env bun
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runLocalCheck, saveLocalCheck, type LocalSolver } from "./local.ts";

/** Run explicitly selected local code with a terminable deadline, never verifier secrets. */
export function moduleSolver(path: string): LocalSolver {
  return async (challenges, signal) => {
    signal.throwIfAborted();
    let resolveResult!: (value: Record<string, string>) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<Record<string, string>>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    // Explicitly discard source logs: Bun's Worker stdout redirection is incomplete.
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "solver-worker.ts")], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
      ipc(message: { ok?: boolean; responses?: Record<string, string> }) {
        if (message?.ok === true && message.responses) resolveResult(message.responses);
        else rejectResult(new Error("solver failed"));
      },
      onExit() { rejectResult(new Error("solver exited without a result")); },
    });
    const abort = () => rejectResult(new Error("solver cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) abort();
      else child.send({ path, challenges, deadline: Date.parse(challenges[0].expiresAt) - 500 });
      return await result;
    } finally {
      signal.removeEventListener("abort", abort);
      child.kill("SIGKILL");
      await child.exited;
    }
  };
}

const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

async function main() {
  let values;
  try { ({ values } = parseArgs({ args: process.argv.slice(2), options: { solver: { type: "string" }, help: { type: "boolean", short: "h" } }, strict: true, allowPositionals: false })); }
  catch { throw new Error("unknown or incomplete option; use bun run try --help"); }
  if (values.help) {
    console.log("Usage: bun run try [--solver ./my-solver.mjs]\n\nCreates four fresh ALGAL puzzles, signs a local receipt, and independently verifies it.\nDefault: scripted public-prompt solver; no credentials, provider, or network calls.\nCustom module: export async function solve(challenges, signal) returning {[challengeId]: answerString}.\nCustom code runs with your local permissions; forward signal to async solver work.\nThe check expires after 180 seconds. Only public receipt and verification metadata are saved.");
    return;
  }
  let solve: LocalSolver | undefined;
  if (values.solver) {
    const path = resolve(values.solver);
    try { if (!statSync(path).isFile()) throw new Error(); }
    catch { throw new Error("--solver must name an existing local module file"); }
    solve = moduleSolver(path);
  }
  console.log(solve ? "Running a fresh local ALGAL check with your solver…" : "Running a fresh local ALGAL check with the scripted demo solver…");
  let result;
  try { result = await runLocalCheck({ solve }); }
  catch { throw new Error("local check could not finish: solver failed, returned invalid responses, or exceeded the 180-second window"); }
  let saved;
  try { saved = saveLocalCheck(result); }
  catch { throw new Error("could not save verified evidence; check write access to results/"); }
  console.log(`${result.verified.pass ? "PASS" : "FAIL"} · ${result.verified.passed}/4 passed · 3 required · signature and scores independently verified`);
  console.log(`Receipt: ${saved.receiptPath}\nVerification record: ${saved.verificationPath}\nIssuer: ${result.issuerPublicKey}\nSHA-256: ${result.sha256}`);
  console.log("Local demonstration with an ephemeral issuer. This is not a model score or hosted attestation.");
  console.log(`\nVerify again:\nbun cloudflare/examples/verify-receipt.mjs ${shellQuote(saved.receiptPath)} --issuer ${result.issuerPublicKey} --session ${result.id} --context ${result.context} --sha256 ${result.sha256}`);
  if (!solve) console.log("\nTry your own solver:\nbun run try --solver ./my-solver.mjs");
  if (!result.verified.pass) process.exitCode = 1;
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "local demonstration failed");
  process.exitCode = 2;
});
