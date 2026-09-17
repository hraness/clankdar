#!/usr/bin/env bun
/**
 * Calibration report: read per-model JSONL runs and emit a comparison table.
 *
 *   bun bench/report.ts results/calibrate [--json report.json]
 *
 * Reports two numbers per cell:
 *   strict   — normalized response equals the answer (the protocol contract)
 *   present  — normalized response ENDS WITH the answer (capability despite prose)
 * `present` is a conservative diagnostic computed from recorded responses; it
 * undercounts correct answers buried mid-response or restructured as prose.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { normalize } from "../ladder/family.ts";

const dir = process.argv[2] ?? "results/calibrate";
const jsonOut = process.argv[4];

type Row = { adapter: string; family: string; tier: number; pass: boolean; response?: string; expected?: string; error?: string };

const models = new Map<string, Row[]>();
for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
  const rows: Row[] = readFileSync(`${dir}/${f}`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => !r.type && r.adapter);
  if (rows.length) models.set(rows[0].adapter, rows);
}

const tiers = [...new Set([...models.values()].flatMap((rs) => rs.map((r) => r.tier)))].sort((a, b) => a - b);

const rate = (rs: Row[], pred: (r: Row) => boolean) => (rs.length ? rs.filter(pred).length / rs.length : undefined);
const present = (r: Row) => r.pass || (r.response != null && r.expected != null && normalize(r.response).endsWith(normalize(r.expected)));

const table = [...models.entries()].map(([name, rows]) => {
  const byTier = Object.fromEntries(tiers.map((t) => {
    const cell = rows.filter((r) => r.tier === t);
    return [t, { n: cell.length, strict: rate(cell, (r) => r.pass), present: rate(cell, present) }];
  }));
  return { model: name, total: rows.length, strict: rate(rows, (r) => r.pass), present: rate(rows, present), byTier, errors: rows.filter((r) => r.error).length };
}).sort((a, b) => (b.present ?? 0) - (a.present ?? 0));

const pct = (x?: number) => (x === undefined ? "  -  " : `${(x * 100).toFixed(0).padStart(3)}%`);
console.log(`\nstrict pass (exact normalized match)`);
console.log(`${"model".padEnd(32)} ${tiers.map((t) => `t${t}`.padStart(5)).join("")}   all`);
for (const m of table) console.log(`${m.model.padEnd(32)} ${tiers.map((t) => pct(m.byTier[t]?.strict).padStart(5)).join("")}  ${pct(m.strict)}`);
console.log(`\nanswer present at response tail (capability diagnostic)`);
console.log(`${"model".padEnd(32)} ${tiers.map((t) => `t${t}`.padStart(5)).join("")}   all`);
for (const m of table) console.log(`${m.model.padEnd(32)} ${tiers.map((t) => pct(m.byTier[t]?.present).padStart(5)).join("")}  ${pct(m.present)}`);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ generated: new Date().toISOString(), seeds: "1-10", models: table }, null, 2) + "\n");
  console.log(`\nwrote ${jsonOut}`);
}
