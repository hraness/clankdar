import { algalWorkedExample } from "../ladder/families/algal.ts";
import { FAMILIES, familyByName, poolForVersion, SUITE_VERSION } from "../ladder/mod.ts";
import type { AgentDiagnostics, CalibrationReport } from "../bench/report.ts";
import { CAPABILITY_PROFILES, profileReport } from "../bench/profiles.ts";
import type { AdmissionArchiveManifest, AdmissionArchiveReport } from "../bench/admission-archive.ts";

export const escapeHtml = (value: string | number): string => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const pct = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;

export const ALGAL_EXAMPLE_CODE = `["fold",
  ["map",
    ["filter", ["get", "values"], "x",
      ["gt", ["get", "x"], 2]],
    "x", ["mul", ["get", "x"], ["get", "x"]]],
  0, "sum", "item",
  ["add", ["get", "sum"], ["get", "item"]]]`;

export function renderChallenge(): string {
  const example = algalWorkedExample();
  if (JSON.stringify(JSON.parse(ALGAL_EXAMPLE_CODE)) !== JSON.stringify(example.expr.program)) throw new Error("displayed Algal program drifted from executable example");
  return `<div class="room-heading hraness-material-terminal__bar"><span>What does this return?</span><span class="example-label">Algal · public practice</span></div>
<div class="sample-body"><p class="sample-input"><code>values = ${escapeHtml(JSON.stringify(example.inputs.values))}</code></p>
<pre class="code algal-code"><code>${escapeHtml(ALGAL_EXAMPLE_CODE)}</code></pre>
<details class="answer-reveal"><summary>See the solution</summary><code>${escapeHtml(example.answer)}</code><p>Keep 3 and 5, square each, then add: 9 + 25 = 34.</p></details>
<p class="sample-note">Executed by the same Algal evaluator used for checks. This public example does not issue a receipt.</p></div>`;
}

/** A frozen published instance; changes to the current frontier pool cannot change this example. */
export function renderHarderChallenge(): string {
  const puzzle = poolForVersion("clankdar-frontier-v0").find((family) => family.name === "bitmatrix")!.generate(4, 302);
  return `<p>Public practice · a harder logic puzzle</p>
<pre class="code"><code>${escapeHtml(puzzle.prompt)}</code></pre>
<details class="answer-reveal"><summary>Reveal the reference answer</summary><code>${escapeHtml(puzzle.answer)}</code><p>Subtracting XOR equations gives x5 = 0 and x4 = 0. Then x1 = 1, x3 = 0, x2 = 1, and x0 = 1.</p></details>
<p class="sample-note">This practice puzzle does not issue a receipt. <a href="/benchmark/frontier-v0/manifest.json">Recorded source and conditions</a>.</p>`;
}

/** One recorded comparison; other suites remain separate downloadable evidence. */
export function renderModelBenchmark(report: CalibrationReport): string {
  const rows = report.models.map((model) => {
    const score = model.eligible;
    return `<tr><th scope="row">${escapeHtml(model.model)}</th><td>${pct(score.strict)}<small>${score.passed}/${score.n} correct</small></td></tr>`;
  }).join("\n");
  return `<div class="table-scroll" role="region" aria-label="Model benchmark results" tabindex="0"><table class="ladder-table benchmark-snapshot"><caption>Exact pass rate · correct answers / completed responses</caption><thead><tr><th scope="col">Requested model</th><th scope="col">Correct</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function renderBenchmarkDownloads(report: CalibrationReport): string {
  return `<ul class="doc-list dataset-links">${report.sources.map(source => `<li><a href="/benchmark/v2-calibration-0/${escapeHtml(source.file)}" download>${escapeHtml(source.file)}</a></li>`).join("\n")}</ul>`;
}

export function renderTiers(): string {
  const labels = ["The floor", "Small steps", "Composition", "State & constraints", "Denser problems", "Search & induction", "Composed induction"];
  const rows = labels.map((label, tier) => `<tr><th scope="row" class="tier">${tier}</th><td>${label}</td><td>${FAMILIES.filter((family) => family.tiers.includes(tier)).map((family) => `<code>${escapeHtml(family.name)}</code>`).join(", ")}</td></tr>`).join("\n");
  return `<table class="ladder-table"><caption>Actual families in ${SUITE_VERSION}; tiers describe generator parameters, not certified model classes.</caption><thead><tr><th scope="col">Tier</th><th scope="col">Focus</th><th scope="col">Families</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderResults(report: CalibrationReport, base: string, caption: string, tiers: number[], track: string): string {
  const rows = report.models.map((model) => {
    const score = model.eligible;
    const interval = score.interval95 ? `${pct(score.interval95[0])}–${pct(score.interval95[1])}` : "—";
    return `<tr><th scope="row"><span class="model-name">${escapeHtml(model.model)}</span></th><td class="score">${pct(score.strict)}</td><td>${pct(score.finalAnswer)}</td><td>${interval}</td><td>${score.passed}/${score.n}</td><td>${score.errors}</td></tr>`;
  }).join("\n");
  const tierRows = report.models.map((model) => `<tr><th scope="row">${escapeHtml(model.model)}</th>${tiers.map((tier) => `<td>${pct(model.byTier[tier]?.strict ?? null)}</td>`).join("")}</tr>`).join("\n");
  const cellsWithData = report.cells.filter((cell) => report.models.some((model) => model.byCell[cell]));
  const cellRows = cellsWithData.map((cell) => `<tr><th scope="row"><code>${escapeHtml(cell)}</code></th>${report.models.map((model) => { const s = model.byCell[cell]; return `<td>${pct(s?.strict ?? null)}<small>${s ? `${s.passed}/${s.n}` : ""}</small></td>`; }).join("")}</tr>`).join("\n");
  const downloads = report.sources.map((source) => `<li><a href="${base}/${escapeHtml(source.file)}" download>${escapeHtml(source.file)}</a></li>`).join("\n");
  return `<div class="table-scroll" role="region" aria-label="${escapeHtml(track)} model comparison, scroll horizontally for all columns" tabindex="0"><table class="ladder-table results-table"><caption>${caption}</caption><thead><tr><th scope="col">Requested model</th><th scope="col">Strict</th><th scope="col">Final block</th><th scope="col">Strict 95% interval</th><th scope="col">Pass / valid</th><th scope="col">Errors</th></tr></thead><tbody>${rows}</tbody></table></div>
<details class="report-details"><summary>Show strict pass rates by cell</summary><div class="table-scroll" role="region" aria-label="${escapeHtml(track)} per-cell results" tabindex="0"><table class="ladder-table results-table cell-table"><caption>Strict pass rates and counts per family/tier cell; cells are the stable unit of comparison.</caption><thead><tr><th scope="col">Cell</th>${report.models.map((model) => `<th scope="col">${escapeHtml(model.model)}</th>`).join("")}</tr></thead><tbody>${cellRows}</tbody></table></div></details>
<details class="report-details"><summary>Show strict pass rates by tier</summary><div class="table-scroll" role="region" aria-label="${escapeHtml(track)} per-tier results" tabindex="0"><table class="ladder-table results-table"><caption>Tier aggregates describe different family mixtures and are not a scalar capability level.</caption><thead><tr><th scope="col">Requested model</th>${tiers.map((tier) => `<th scope="col">t${tier}</th>`).join("")}</tr></thead><tbody>${tierRows}</tbody></table></div></details>
<details class="report-details"><summary>Download attempt records</summary><p>Gzipped JSONL, one file per model. The report recomputes every score from the retained responses.</p><ul class="doc-list dataset-links">${downloads}</ul></details>`;
}

export const renderPilot = (report: CalibrationReport): string => renderResults(report, "/benchmark/pilot-v0", "Screened legacy pilot: 190 instances per model, minus provider errors. One response per instance. No tools.", [0, 1, 2, 3, 4, 5], "Legacy pilot");
export const renderV2 = (report: CalibrationReport): string => renderResults(report, "/benchmark/v2-calibration-0", "Held-out v2 calibration: 500 instances per model, minus provider errors. One response per instance. No tools.", [0, 1, 2, 3, 4, 5, 6], "v2");
export const renderFrontier = (report: CalibrationReport): string => renderResults(report, "/benchmark/frontier-v0", "Held-out frontier calibration: 340 instances per model. One response per instance. No tools. Deeper tiers for eight scalable families.", [4, 5, 6, 7], "Frontier") + "<p class='note'>Frontier cells use parameters beyond the v2 floor and are not comparable to v2 scores. The lower overall pass rates are intentional; the purpose is a steeper ceiling, not a fair comparison to v2.</p>";
export function renderAgent(report: CalibrationReport, diagnostics: AgentDiagnostics[]): string {
  const diagRows = diagnostics.map((diag) => {
    const emitted = diag.episodes ? pct(diag.finalEmitted / diag.episodes) : "—";
    const toolFailures = diag.toolErrors.protocol + diag.toolErrors.unknownTool + diag.toolErrors.invalidArgs + diag.toolErrors.callBudget;
    return `<tr><th scope="row"><span class="model-name">${escapeHtml(diag.model)}</span></th><td>${emitted}</td><td>${diag.budgetExhausted}</td><td>${diag.meanToolCalls === null ? "—" : diag.meanToolCalls.toFixed(1)}</td><td>${diag.meanTurns === null ? "—" : diag.meanTurns.toFixed(1)}</td><td>${toolFailures}<small>protocol ${diag.toolErrors.protocol} · unknown ${diag.toolErrors.unknownTool} · args ${diag.toolErrors.invalidArgs} · budget ${diag.toolErrors.callBudget}</small></td></tr>`;
  }).join("\n");
  return renderResults(report, "/benchmark/agent-v0", "Held-out bounded tool-agent calibration: 120 episodes per model. Per-cell budgets of 4-12 tool calls and 8-16 turns, 4,096 characters per tool output. Transcripts are replayable.", [5, 6, 7], "Tool-agent") + `
<details class="report-details"><summary>Show episode diagnostics</summary><div class="table-scroll" role="region" aria-label="Episode diagnostics" tabindex="0"><table class="ladder-table results-table"><caption>Protocol and effort metrics from recorded episodes. FINAL emitted and budget exhaustion describe protocol adherence, not correctness.</caption><thead><tr><th scope="col">Requested model</th><th scope="col">FINAL emitted</th><th scope="col">Budget exhausted</th><th scope="col">Mean tool calls</th><th scope="col">Mean turns</th><th scope="col">Failed tool calls</th></tr></thead><tbody>${diagRows}</tbody></table></div></details>
<p class="note">This is a separate track. Scores do not estimate base-model capability and are not comparable to unaided runs.</p>`;
}

export function renderAdmissionEvidence(report: AdmissionArchiveReport, manifest: AdmissionArchiveManifest): string {
  const rows = Object.entries(report.tracks).map(([track, score]) => `<tr><th scope="row">${escapeHtml(track)}</th><td class="score">${score.passed}/${score.challenges}</td><td>${score.admitted}/${score.sessions}</td></tr>`).join("\n");
  return `<div class="table-scroll" role="region" aria-label="Signed admission evidence" tabindex="0"><table class="ladder-table results-table"><caption>Four live, zero-tool sessions. Every admission signature, seed commitment, regenerated instance, typed score, and verdict is checked during the site build.</caption><thead><tr><th scope="col">Track</th><th scope="col">Challenges passed</th><th scope="col">Sessions admitted</th></tr></thead><tbody>${rows}</tbody></table></div>
<p><a href="/benchmark/admissions-opus5-2026-09-19/manifest.json">Inspect the signed admission manifest</a> or replay it with <code>bun bench/admission-archive.ts verify</code>. Requested adapter: <code>${escapeHtml(manifest.producerClaim.adapter)}</code>; provider-reported resolved model: <code>${escapeHtml(manifest.producerClaim.resolvedModel)}</code>; tools: <code>${escapeHtml(manifest.producerClaim.tools)}</code>.</p>
<p class="note">${escapeHtml(manifest.producerClaim.caveat)} The runner worktree was recorded as ${manifest.runner.sourceDirty ? "dirty" : "clean"}; inspect the pinned source revision and archive manifest. Four sessions are product evidence, not a calibrated capability estimate; the larger published calibrations remain the statistical evidence.</p>`;
}

export function renderProfiles(report: CalibrationReport): string {
  const results = profileReport(report);
  const rows = results.map((result) => `<tr><th scope="row">${escapeHtml(result.model)}</th>${CAPABILITY_PROFILES.map((profile) => {
    const score = result.profiles[profile.id];
    return `<td><span class="score">${pct(score.strict)}</span><small>${score.passed}/${score.n}</small></td>`;
  }).join("")}</tr>`).join("\n");
  const definitions = CAPABILITY_PROFILES.map((profile) => `<li><b>${escapeHtml(profile.name)}.</b> ${escapeHtml(profile.description)} <span class="note">${profile.cells.map((cell) => `<code>${escapeHtml(cell)}</code>`).join(", ")}</span></li>`).join("\n");
  return `<div class="table-scroll" role="region" aria-label="Capability profile results" tabindex="0"><table class="ladder-table results-table profile-table"><caption>Strict pass rates. Every v2 cell belongs to exactly one profile; sample sizes differ by profile.</caption><thead><tr><th scope="col">Requested model</th>${CAPABILITY_PROFILES.map((profile) => `<th scope="col">${escapeHtml(profile.name)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
<details class="report-details"><summary>Show profile contracts and included cells</summary><ul class="doc-list">${definitions}</ul></details>`;
}
