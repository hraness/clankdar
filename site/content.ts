import { FAMILIES, familyByName, SUITE_VERSION } from "../ladder/mod.ts";
import type { CalibrationReport } from "../bench/report.ts";

export const escapeHtml = (value: string | number): string => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const pct = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;

export function renderChallenge(): string {
  const puzzle = familyByName("echo")!.generate(0, 5);
  return `<div class="room-heading hraness-material-terminal__bar"><span>clankdar / t0</span><span class="example-label">Public practice</span></div>
<div class="sample-body"><p class="eyebrow">${escapeHtml(puzzle.family)} · seed ${puzzle.seed}</p><p class="sample-prompt">${escapeHtml(puzzle.prompt)}</p>
<details class="answer-reveal"><summary>Reveal the reference answer</summary><code>${escapeHtml(puzzle.answer)}</code></details>
<p class="sample-note">Tiny on purpose. Six more rungs above it.<br>This is a practice puzzle, not an admission token.</p></div>`;
}

export function renderTiers(): string {
  const labels = ["The floor", "Small steps", "Composition", "State & constraints", "Denser problems", "Search & induction", "Composed induction"];
  const rows = labels.map((label, tier) => `<tr><th scope="row" class="tier">${tier}</th><td>${label}</td><td>${FAMILIES.filter((family) => family.tiers.includes(tier)).map((family) => `<code>${escapeHtml(family.name)}</code>`).join(", ")}</td></tr>`).join("\n");
  return `<table class="ladder-table"><caption>Actual families in ${SUITE_VERSION}; tiers describe generator parameters, not certified model classes.</caption><thead><tr><th scope="col">Tier</th><th scope="col">Focus</th><th scope="col">Families</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderResults(report: CalibrationReport, base: string, caption: string, tiers: number[]): string {
  const rows = report.models.map((model) => {
    const score = model.eligible;
    const interval = score.interval95 ? `${pct(score.interval95[0])}–${pct(score.interval95[1])}` : "—";
    return `<tr><th scope="row"><span class="model-name">${escapeHtml(model.model)}</span></th><td class="score">${pct(score.strict)}</td><td>${pct(score.finalAnswer)}</td><td>${interval}</td><td>${score.passed}/${score.n}</td><td>${score.errors}</td></tr>`;
  }).join("\n");
  const tierRows = report.models.map((model) => `<tr><th scope="row">${escapeHtml(model.model)}</th>${tiers.map((tier) => `<td>${pct(model.byTier[tier]?.strict ?? null)}</td>`).join("")}</tr>`).join("\n");
  const downloads = report.sources.map((source) => `<li><a href="${base}/${escapeHtml(source.file)}" download>${escapeHtml(source.file)}</a></li>`).join("\n");
  return `<div class="table-scroll" role="region" aria-label="Model comparison, scroll horizontally for all columns" tabindex="0"><table class="ladder-table results-table"><caption>${caption}</caption><thead><tr><th scope="col">Requested model</th><th scope="col">Strict</th><th scope="col">Final block</th><th scope="col">Strict 95% interval</th><th scope="col">Pass / valid</th><th scope="col">Errors</th></tr></thead><tbody>${rows}</tbody></table></div>
<details class="report-details"><summary>Show strict pass rates by tier</summary><div class="table-scroll" role="region" aria-label="Per-tier results" tabindex="0"><table class="ladder-table results-table"><caption>Tier aggregates describe different family mixtures and are not a scalar capability level.</caption><thead><tr><th scope="col">Requested model</th>${tiers.map((tier) => `<th scope="col">t${tier}</th>`).join("")}</tr></thead><tbody>${tierRows}</tbody></table></div></details>
<details class="report-details"><summary>Download attempt records</summary><p>Gzipped JSONL, one file per model. The report recomputes every score from the retained responses.</p><ul class="doc-list dataset-links">${downloads}</ul></details>`;
}

export const renderPilot = (report: CalibrationReport): string => renderResults(report, "/benchmark/pilot-v0", "Screened legacy pilot: 190 instances per model, minus provider errors. One response per instance. No tools.", [0, 1, 2, 3, 4, 5]);
export const renderV2 = (report: CalibrationReport): string => renderResults(report, "/benchmark/v2-calibration-0", "Held-out v2 calibration: 500 instances per model, minus provider errors. One response per instance. No tools.", [0, 1, 2, 3, 4, 5, 6]);
