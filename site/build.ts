import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { supportFooter } from "./support-footer.ts";
import { renderAgent, renderChallenge, renderFrontier, renderPilot, renderProfiles, renderTiers, renderV2 } from "./content.ts";
import { verifyPilot } from "../bench/pilot.ts";
import { verifyCalibration } from "../bench/archive.ts";
import { agentDiagnostics, readRuns } from "../bench/report.ts";
import { SUITE_VERSION, SCORER_VERSION } from "../ladder/mod.ts";
import { CAPABILITY_PROFILES, profileReport } from "../bench/profiles.ts";
const root = import.meta.dir;
const output = resolve(root, "dist");
const kit = dirname(fileURLToPath(import.meta.resolve("@hraness/design-kit/paper-theme.css")));
const pages = ["index.html", "docs/index.html", "benchmark/index.html"];
const pilot = verifyPilot(resolve(root, "benchmark/pilot-v0"));
const v2 = verifyCalibration(resolve(root, "benchmark/v2-calibration-0"));
const frontier = verifyCalibration(resolve(root, "benchmark/frontier-v0"));
const agent = verifyCalibration(resolve(root, "benchmark/agent-v0"));
const agentDiag = agentDiagnostics(readRuns(resolve(root, "benchmark/agent-v0")));
const substitutions: Record<string, string> = {
  "{{CHALLENGE}}": renderChallenge(), "{{TIERS}}": renderTiers(), "{{PILOT_RESULTS}}": renderPilot(pilot), "{{V2_RESULTS}}": renderV2(v2), "{{FRONTIER_RESULTS}}": renderFrontier(frontier), "{{AGENT_RESULTS}}": renderAgent(agent, agentDiag), "{{PROFILE_RESULTS}}": renderProfiles(v2),
  "{{SUITE_VERSION}}": SUITE_VERSION, "{{SCORER_VERSION}}": SCORER_VERSION,
};
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "design"), { recursive: true });
for (const name of ["styles.css", "icon.png", "apple-icon.png", "robots.txt", "sitemap.xml", "llms.txt"]) await cp(resolve(root, name), resolve(output, name));
await cp(resolve(root, "icons"), resolve(output, "icons"), { recursive: true });
await cp(resolve(root, "marks"), resolve(output, "marks"), { recursive: true });
const footerMarker = "<!-- hraness-site-footer -->";
for (const page of pages) {
  let html = await readFile(resolve(root, page), "utf8");
  if (html.split(footerMarker).length !== 2) throw new Error(`Expected one shared footer slot in ${page}.`);
  for (const [marker, content] of Object.entries(substitutions)) html = html.replaceAll(marker, content);
  if (/\{\{[A-Z_]+\}\}/.test(html)) throw new Error(`Unresolved content slot in ${page}`);
  const target = resolve(output, page);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, html.replace(footerMarker, supportFooter()));
}
for (const archive of ["pilot-v0", "v2-calibration-0", "frontier-v0", "agent-v0"]) await cp(resolve(root, `benchmark/${archive}`), resolve(output, `benchmark/${archive}`), { recursive: true });
await writeFile(resolve(output, "benchmark/v2-calibration-0/profiles.json"), JSON.stringify({ schemaVersion: 1, suiteHash: v2.suiteHash, profiles: CAPABILITY_PROFILES, models: profileReport(v2) }, null, 2) + "\n");
await cp(fileURLToPath(import.meta.resolve("@hraness/site-footer/stylex.css")), resolve(output, "footer.css"));
const files = ["paper-theme.css", "product-marketing-preset.css", "lantern-material.css", "appearance-menu.css", "fonts.css"];
for (const name of files) await cp(resolve(kit, name), resolve(output, "design", name));
await cp(resolve(kit, "fonts/nebula-sans"), resolve(output, "design/fonts/nebula-sans"), { recursive: true });
await cp(resolve(kit, "fonts/instrument-serif"), resolve(output, "design/fonts/instrument-serif"), { recursive: true });
await cp(resolve(kit, "fonts/geist-mono"), resolve(output, "design/fonts/geist-mono"), { recursive: true });
await cp(resolve(kit, "marketing-assets"), resolve(output, "design/marketing-assets"), { recursive: true });
await cp(resolve(kit, "../LICENSE"), resolve(output, "design/LICENSE"));
const result = await Bun.build({ entrypoints: [resolve(root, "appearance.ts")], outdir: output, naming: "appearance.js", target: "browser", format: "iife", minify: true });
if (!result.success) throw new AggregateError(result.logs, "Appearance bundle failed");
const pkg = JSON.parse(await readFile(resolve(kit, "../package.json"), "utf8"));
await writeFile(resolve(output, "design/source.json"), JSON.stringify({ package: pkg.name, version: pkg.version, files: Object.fromEntries(await Promise.all(files.map(async name => [name, createHash("sha256").update(await readFile(resolve(output, "design", name))).digest("hex")]))) }, null, 2));
console.log(`Built Clankdar (${pages.length} pages) with ${pkg.name}@${pkg.version}.`);
