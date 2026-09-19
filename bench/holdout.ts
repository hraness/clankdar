#!/usr/bin/env bun
/**
 * clankdar-holdout-v1 — private derived pools for held-out challenge cells.
 *
 *   bun bench/holdout.ts gen --suite frontier --cells sat:t4,knights:t5 --out pool.json
 *   bun bench/holdout.ts info pool.json
 *
 * A holdout pool re-parameterizes published generators with secret labels:
 * the held-out instance for a cell is `generate(tier, mixSeed(label, seed))`.
 * Challenges minted from a pool carry `heldout: {poolKey}`; the seed is
 * revealed in the receipt as usual, but only a checker holding the pool can
 * replay the instance — everyone else verifies the signature, commitment,
 * timing, and subject proof while the score stays issuer-claimed.
 *
 * Publishing the pool later upgrades every historical held-out receipt to
 * fully replayable (deferred disclosure). A held-out cell is the same puzzle
 * family under an unpublished parameterization: it prevents instance lookup
 * and precomputation against the stream, but a general solver for the family
 * still solves it — held-out is not a new puzzle type.
 */
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { canonical, sha256 } from "./canon.ts";
import { poolForVersion, suiteVersion, type SuiteName } from "../ladder/mod.ts";
import { mixSeed } from "../ladder/rng.ts";
import type { Instance } from "../ladder/family.ts";

export const HOLDOUT_PROTOCOL = "clankdar-holdout-v1";
const MAX_CELLS = 256;
const LABEL = /^[A-Za-z0-9_-]{22,128}$/;

/** One held-out cell: a published generator cell plus a secret stream label. */
export interface HoldoutCell {
  family: string;
  tier: number;
  /** Secret seed-mix label (>=128 bits); revealing it replays the stream. */
  label: string;
}

export interface HoldoutPool {
  protocol: typeof HOLDOUT_PROTOCOL;
  /** Published suite whose generators the labels re-parameterize. */
  suite: SuiteName;
  /** sha256 over canonical({protocol, suite, cells}) — binds labels and cells. */
  poolKey: string;
  cells: HoldoutCell[];
}

export const poolKeyOf = (suite: SuiteName, cells: HoldoutCell[]): string =>
  sha256(canonical({ protocol: HOLDOUT_PROTOCOL, suite, cells }));

const cellId = (c: { family: string; tier: number }) => `${c.family}:t${c.tier}`;

/** Strictly parse a pool file and re-check its poolKey commitment. */
export function parsePool(value: unknown): HoldoutPool {
  const fail = (message: string): never => {
    throw new Error(`invalid holdout pool: ${message}`);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
  const p = value as Record<string, unknown>;
  if (p.protocol !== HOLDOUT_PROTOCOL) fail(`protocol must be ${HOLDOUT_PROTOCOL}`);
  if (p.suite !== "v2" && p.suite !== "frontier" && p.suite !== "agent" && p.suite !== "algal") fail("suite must be v2, frontier, agent, or algal");
  const suite = p.suite as SuiteName;
  if (!Array.isArray(p.cells) || !p.cells.length || p.cells.length > MAX_CELLS) fail(`cells must be 1..${MAX_CELLS} objects`);
  const base = poolForVersion(suiteVersion(suite));
  const cells: HoldoutCell[] = [];
  for (const raw of p.cells as unknown[]) {
    const cell = raw as Record<string, unknown> | null;
    const family = cell && typeof cell.family === "string" ? base.find((f) => f.name === cell.family) : undefined;
    if (!family || !Number.isInteger(cell!.tier) || !family.tiers.includes(cell!.tier as number)) fail(`unknown base cell: ${JSON.stringify(raw)}`);
    const label = typeof cell!.label === "string" && LABEL.test(cell!.label) ? cell!.label : fail("cell label must be 22..128 base64url chars");
    cells.push({ family: cell!.family as string, tier: cell!.tier as number, label });
  }
  if (new Set(cells.map(cellId)).size !== cells.length) fail("cells must be distinct");
  if (p.poolKey !== poolKeyOf(suite, cells)) fail("poolKey does not commit the cell list");
  return { protocol: HOLDOUT_PROTOCOL, suite, poolKey: p.poolKey as string, cells };
}

export const holdoutCell = (pool: HoldoutPool, family: string, tier: number): HoldoutCell | undefined =>
  pool.cells.find((c) => c.family === family && c.tier === tier);

/** Regenerate a held-out instance; the recorded seed stays the public caller seed. */
export function holdoutInstance(pool: HoldoutPool, cell: HoldoutCell, seed: number): Instance {
  const family = poolForVersion(suiteVersion(pool.suite)).find((f) => f.name === cell.family);
  if (!family || !family.tiers.includes(cell.tier)) throw new Error(`unknown base cell for ${pool.suite}: ${cellId(cell)}`);
  return { ...family.generate(cell.tier, mixSeed(cell.label, seed)), seed };
}

/** Mint a pool: one fresh secret label per listed base cell ("family:tN"). */
export function generatePool(opts: { suite: SuiteName; cells: string[] }): HoldoutPool {
  const base = poolForVersion(suiteVersion(opts.suite));
  const cells: HoldoutCell[] = opts.cells.map((id) => {
    const match = /^([a-z0-9]+):t(\d+)$/.exec(id);
    const family = match && base.find((f) => f.name === match[1]);
    if (!match || !family || !family.tiers.includes(Number(match[2]))) throw new Error(`unknown cell for suite ${opts.suite}: ${id}`);
    return { family: match[1], tier: Number(match[2]), label: randomBytes(24).toString("base64url") };
  });
  if (new Set(cells.map(cellId)).size !== cells.length) throw new Error("cells must be distinct");
  return { protocol: HOLDOUT_PROTOCOL, suite: opts.suite, poolKey: poolKeyOf(opts.suite, cells), cells };
}

const loadJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export function main(args = process.argv.slice(2)): void {
  const [command, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    options: { suite: { type: "string" }, cells: { type: "string" }, out: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true, strict: true,
  });
  const usage = "usage: holdout gen --suite v2|frontier|agent|algal --cells f:t1,g:t2 --out POOL.json | holdout info POOL.json";
  if (values.help || !command) {
    console.log(usage);
    return;
  }
  if (command === "gen") {
    if (!values.suite || !values.cells) throw new Error(`gen requires --suite and --cells.\n${usage}`);
    const pool = generatePool({ suite: values.suite as SuiteName, cells: values.cells.split(",").map((c) => c.trim()) });
    if (values.out) writeFileSync(values.out, JSON.stringify(pool, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    else console.log(JSON.stringify(pool, null, 2));
    console.error(`pool ${pool.poolKey.slice(0, 16)}…: ${pool.cells.length} held-out cells over ${pool.suite} — keep the file private`);
    return;
  }
  if (command === "info") {
    const pool = parsePool(loadJson(positionals[0] ?? ""));
    console.log(JSON.stringify({ protocol: pool.protocol, suite: pool.suite, poolKey: pool.poolKey, cells: pool.cells.map(cellId) }, null, 2));
    return;
  }
  throw new Error(`unknown command: ${command}.\n${usage}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
