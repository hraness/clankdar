/** CLI-selected code gets public data only; this subprocess is not a sandbox. */
import { pathToFileURL } from "node:url";
import type { LocalSolver } from "./local.ts";
import type { HostedChallenge } from "../cloudflare/src/challenges.ts";

process.once("message", async (input: { path: string; challenges: HostedChallenge[]; deadline: number }) => {
  try {
    const module = await import(pathToFileURL(input.path).href) as { solve?: LocalSolver };
    if (typeof module.solve !== "function") throw new Error("missing solve export");
    const signal = AbortSignal.timeout(Math.max(1, input.deadline - Date.now()));
    process.send!({ ok: true, responses: await module.solve(input.challenges, signal) });
  } catch {
    // Never relay thrown provider payloads, credentials, or source stack traces.
    process.send!({ ok: false });
  }
});
