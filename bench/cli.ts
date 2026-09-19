#!/usr/bin/env bun
/**
 * Clankdar bench runner.
 *
 *   bun bench --adapter oracle --seeds 1-20
 *   bun bench --adapter openai:gpt-4o-mini --seeds 1-10 --tiers 0-3 --out results/gpt-4o-mini.jsonl
 *
 * Writes one JSONL row per attempted instance (to --out or stdout) and prints a
 * pass-rate summary by tier and family to stderr. Model calls need --execute.
 */
import { parseArgs } from "node:util";
import { adapterByName, cli, openai, openaiAgent, oracle } from "./adapters.ts";
import { FAMILIES, FRONTIER_FAMILIES, AGENT_FAMILIES, ALGAL_FAMILIES, ALGAL_SUITE_VERSION, SUITE_VERSION, FRONTIER_SUITE_VERSION, AGENT_SUITE_VERSION } from "../ladder/mod.ts";
import { commonOptions, integer, requestBudget, selection } from "./options.ts";
import { recordRun, runManifest, percent } from "./record.ts";

const HELP = `usage: bun bench --adapter <oracle|echo|openai:model|agent:openai:model|cli:program:model> [options]

  --list               list suites, families, and tiers
  --suite <name>       v2 (published), frontier (deeper unaided cells),
                       agent (bounded tool-agent protocol), or
                       algal (bounded expression evaluation); default v2
  --seeds <spec>       unique seeds, e.g. 1-20 or 1,2,3 (default 1-10)
  --tiers <spec>       restrict tiers, e.g. 0-3
  --families <list>    comma-separated family names
  --concurrency <n>    parallel solver calls, 1..64 (default 4)
  --timeout-ms <n>     per-instance time budget (default 120000)
  --max-tokens <n>     completion token budget (default 4096)
  --out <path>        create a NEW JSONL file; never overwrite (default stdout)
  --dry-run           show the manifest without running
  --execute           enable model API calls (default is a dry run for models)
  --max-requests <n>   required with --execute; includes parameter negotiation

No credentials are accepted in command-line arguments. Use CLANKDAR_API_KEY
and CLANKDAR_BASE_URL, or the OPENAI_* equivalents. No-key loopback is supported.
`;

export async function main(args = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({ args, options: { ...commonOptions, adapter: { type: "string" }, list: { type: "boolean" } }, strict: true, allowPositionals: false });
  if (values.help) { console.log(HELP); return 0; }
  if (values.list) {
    console.log(`${SUITE_VERSION}:`);
    for (const f of FAMILIES) console.log(`  ${f.name}\ttiers ${f.tiers.join(",")}`);
    console.log(`${FRONTIER_SUITE_VERSION}:`);
    for (const f of FRONTIER_FAMILIES) console.log(`  ${f.name}\ttiers ${f.tiers.join(",")}`);
    console.log(`${AGENT_SUITE_VERSION}:`);
    for (const f of AGENT_FAMILIES) console.log(`  ${f.name}\ttiers ${f.tiers.join(",")}`);
    console.log(`${ALGAL_SUITE_VERSION}:`);
    for (const f of ALGAL_FAMILIES) console.log(`  ${f.name}\ttiers ${f.tiers.join(",")}`);
    return 0;
  }
  if (!values.adapter) throw new Error("--adapter is required (use --help)");
  const opts = selection(values);
  const remote = values.adapter.startsWith("openai:");
  const remoteAgent = values.adapter.startsWith("agent:openai:");
  const remoteCli = values.adapter.startsWith("cli:");
  const budget = values["max-requests"] ? requestBudget(integer(values["max-requests"], 30_000)) : undefined;
  const adapter = remote
    ? openai({ model: values.adapter.slice(7), maxTokens: integer(values["max-tokens"] ?? "4096", 32_768), timeoutMs: opts.timeoutMs, beforeRequest: budget?.beforeRequest })
    : remoteAgent
      ? openaiAgent({ model: values.adapter.slice(13), maxTokens: integer(values["max-tokens"] ?? "4096", 32_768), timeoutMs: opts.timeoutMs, beforeRequest: budget?.beforeRequest })
      : remoteCli
        ? (() => {
            const rest = values.adapter!.slice(4);
            const sep = rest.indexOf(":");
            if (sep < 1) throw new Error("cli adapters need a program and model (cli:<program>:<model>)");
            return cli(rest.slice(0, sep), { model: rest.slice(sep + 1), timeoutMs: opts.timeoutMs, beforeRequest: budget?.beforeRequest });
          })()
        : adapterByName(values.adapter);
  if (opts.suite === "agent" && !adapter.agent && adapter !== oracle) throw new Error("the agent suite requires an agent-capable adapter (agent:openai:<model> or oracle)");
  if (opts.suite !== "agent" && remoteAgent) throw new Error("agent:openai:<model> adapters only run the agent suite (--suite agent)");
  const manifest = runManifest(adapter, opts);
  if (values["dry-run"] || ((remote || remoteAgent || remoteCli) && !values.execute)) {
    console.log(JSON.stringify({ ...manifest, dryRun: true, maximumRequests: manifest.instances * (remoteAgent ? 30 : remoteCli ? 1 : 3) }, null, 2));
    return 0;
  }
  if ((remote || remoteAgent || remoteCli) && (!budget || integer(values["max-requests"]!, 30_000) < manifest.instances)) throw new Error("--execute requires --max-requests at least equal to the instance count");
  const summary = await recordRun(adapter, opts, values.out);
  console.error(`${adapter.name}: ${summary.passed}/${summary.attempted} valid responses passed (${percent(summary.rate)}); ${summary.errors} provider/adapter errors`);
  for (const [tier, cell] of Object.entries(summary.byTier)) console.error(`  t${tier}: ${cell.passed}/${cell.attempted} (${percent(cell.rate)}), ${cell.errors} errors`);
  for (const [family, cell] of Object.entries(summary.byFamily)) console.error(`  ${family}: ${cell.passed}/${cell.attempted} (${percent(cell.rate)})`);
  return summary.errors ? 1 : 0;
}

if (import.meta.main) {
  try { process.exitCode = await main(); } catch (error) { console.error(error instanceof Error ? error.message : "benchmark failed"); process.exitCode = 2; }
}
