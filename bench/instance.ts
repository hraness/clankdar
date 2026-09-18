#!/usr/bin/env bun
/**
 * Generator oracle: emit one canonical instance as JSON.
 *
 *   bun bench/instance.ts --suite frontier --family cryptarithm --tier 5 --seed 42
 *
 * Used by the standalone attestation verifier (valhalla prototype) to
 * regenerate instances for issue/deep-check. Output is the instance's prompt
 * and canonical answer only; the seed is caller-supplied.
 */
import { parseArgs } from "node:util";
import { poolForVersion, suiteVersion, type SuiteName } from "../ladder/mod.ts";

export function main(args = process.argv.slice(2)): void {
  const { values } = parseArgs({
    args,
    options: { suite: { type: "string" }, "suite-version": { type: "string" }, family: { type: "string" }, tier: { type: "string" }, seed: { type: "string" }, help: { type: "boolean", short: "h" } },
    strict: true,
  });
  if (values.help) { console.log("usage: instance (--suite v2|frontier|agent | --suite-version VERSION) --family NAME --tier N --seed N"); return; }
  if (!values.family || values.tier === undefined || values.seed === undefined) throw new Error("requires --family --tier --seed");
  if (!values.suite === !values["suite-version"]) throw new Error("pass exactly one of --suite or --suite-version");
  const version = values["suite-version"] ?? suiteVersion(values.suite as SuiteName);
  if (values.suite && !["v2", "frontier", "agent"].includes(values.suite)) throw new Error("suite must be v2, frontier, or agent");
  const family = poolForVersion(version).find((f) => f.name === values.family);
  const tier = Number(values.tier);
  const seed = Number(values.seed);
  if (!family || !family.tiers.includes(tier)) throw new Error(`unknown cell for ${version}: ${values.family}:t${tier}`);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("seed must be a uint32");
  const instance = family.generate(tier, seed);
  console.log(JSON.stringify({ suiteVersion: version, family: instance.family, tier: instance.tier, seed: instance.seed, prompt: instance.prompt, answer: instance.answer }));
}

if (import.meta.main) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "instance failed"); process.exitCode = 2; }
}
