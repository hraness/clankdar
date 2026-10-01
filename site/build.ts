import { withAnalytics } from "./analytics-site";
import { renderMarketingCopy } from "./portfolio-copy";
import { portfolioMarkAssets, portfolioMarkManifest } from "./portfolio-marks";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { renderPractice } from "./practice-data.ts";
import { supportFooter } from "./support-footer.ts";
import { renderBenchmarkDownloads, renderModelBenchmark, renderChallenge, renderHarderChallenge, renderCode } from "./content.ts";
import { verifyPilot } from "../bench/pilot.ts";
import { verifyCalibration } from "../bench/archive.ts";
import { verifyAdmissionArchive } from "../bench/admission-archive.ts";
import { CAPABILITY_PROFILES, profileReport } from "../bench/profiles.ts";
import { POSTS } from "./blog/articles.ts";
import { BLOG_PATH } from "./blog/articles.ts";
import { BLOG_SOCIAL_CARD, FEED_PATH, indexablePosts, postSocialCard, renderFeed, renderIndexPage, renderLlmsSection, renderPostPage, renderSitemap } from "./blog/render.ts";
import { STATIC_PAGES, renderNotFound, routeLabel } from "./not-found.ts";
import { PAGE_JSON_LD } from "./structured-data.ts";
import { renderHomeMockups } from "./launch/home.tsx";
import { serializeJsonLd } from "@hraness/web-discovery";
import { PAGE_SOCIAL_IMAGES, renderSocialImage, socialImage, socialImageMeta } from "./social.ts";
const root = import.meta.dir;
const output = resolve(root, "dist");
const kit = dirname(fileURLToPath(import.meta.resolve("@hraness/design-kit/paper-theme.css")));
const pages = ["index.html", "docs/index.html", "benchmark/index.html"];
verifyPilot(resolve(root, "benchmark/pilot-v0"));
const v2 = verifyCalibration(resolve(root, "benchmark/v2-calibration-0"));
verifyCalibration(resolve(root, "benchmark/frontier-v0"));
verifyCalibration(resolve(root, "benchmark/agent-v0"));
const admissionDir = resolve(root, "benchmark/admissions-opus5-2026-09-19");
verifyAdmissionArchive(admissionDir);
const substitutions: Record<string, string> = {
  "{{LOCAL_DEMO_COMMANDS}}": renderCode("git clone https://github.com/hraness/clankdar.git\ncd clankdar\nbun install --frozen-lockfile --ignore-scripts\nbun run try", "shell", "span"),
  "{{VERIFY_COMMAND}}": renderCode('bun cloudflare/examples/verify-receipt.mjs receipt.json \\\n  --issuer="$EXPECTED_ISSUER_PUBLIC_KEY"', "shell"),
  "{{PRACTICE}}": renderPractice(),
  "{{ALGAL_CHALLENGE}}": renderChallenge(),
  "{{HARDER_CHALLENGE}}": renderHarderChallenge(),
  "{{MODEL_BENCHMARK}}": renderModelBenchmark(v2),
  "{{BENCHMARK_DOWNLOADS}}": renderBenchmarkDownloads(v2),
  ...renderHomeMockups(),
};
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "design"), { recursive: true });
for (const name of ["styles.css", "icon.png", "icon-512.png", "apple-icon.png", "favicon.svg", "robots.txt"]) await cp(resolve(root, name), resolve(output, name));
await cp(resolve(root, "../cloudflare/examples/check.mjs"), resolve(output, "clankdar-client.mjs"));
await cp(resolve(root, "icons"), resolve(output, "icons"), { recursive: true });
await cp(resolve(root, "marks"), resolve(output, "marks"), { recursive: true });
await mkdir(resolve(output, "marks/portfolio"), { recursive: true });
for (const asset of portfolioMarkAssets) await writeFile(resolve(output, asset.href.slice(1)), asset.svg);
await writeFile(resolve(output, "marks/portfolio/manifest.json"), JSON.stringify(portfolioMarkManifest, null, 2) + "\n");
const footerMarker = "<!-- hraness-site-footer -->";
for (const page of pages) {
  let html = renderMarketingCopy(await readFile(resolve(root, page), "utf8"));
  if (html.split(footerMarker).length !== 2) throw new Error(`Expected one shared footer slot in ${page}.`);
  for (const [marker, content] of Object.entries(substitutions)) html = html.replaceAll(marker, content);
  const social = PAGE_SOCIAL_IMAGES[page];
  if (social === undefined || html.split("{{SOCIAL_IMAGE}}").length !== 2) throw new Error(`Expected one social image slot and card for ${page}.`);
  html = html.replace("{{SOCIAL_IMAGE}}", socialImageMeta(socialImage(social.path, social.page)).join("\n    "));
  if (/\{\{[A-Z_]+\}\}/.test(html)) throw new Error(`Unresolved content slot in ${page}`);
  const jsonLd = PAGE_JSON_LD[page];
  if (jsonLd !== undefined) {
    if (html.split("</head>").length !== 2) throw new Error(`Expected one </head> in ${page}.`);
    html = html.replace("</head>", `  <script type="application/ld+json">${serializeJsonLd(jsonLd())}</script>\n  </head>`);
  }
  const target = resolve(output, page);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, withAnalytics(html.replace(footerMarker, supportFooter())));
}
const blogTemplate = await readFile(resolve(root, "blog/page.html"), "utf8");
if (blogTemplate.split(footerMarker).length !== 2) throw new Error("Expected one shared footer slot in blog/page.html.");
const blogPages: [string, string][] = [["blog/index.html", renderIndexPage(blogTemplate)], ...POSTS.map(post => [`${post.path.slice(1)}.html`, renderPostPage(blogTemplate, post)] as [string, string])];
for (const [page, html] of blogPages) {
  if (/\{\{[A-Z_]+\}\}/.test(html)) throw new Error(`Unresolved content slot in ${page}`);
  const target = resolve(output, page);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, withAnalytics(html.replace(footerMarker, supportFooter())));
}
// Every share image comes from the shared template through site/social.ts.
const socialCards = [...Object.values(PAGE_SOCIAL_IMAGES), BLOG_SOCIAL_CARD, ...POSTS.map(postSocialCard)];
for (const card of socialCards) {
  const target = resolve(output, card.path.slice(1));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, await renderSocialImage(card.page));
}
await writeFile(resolve(output, FEED_PATH.slice(1)), renderFeed());
await writeFile(resolve(output, "sitemap.xml"), renderSitemap(STATIC_PAGES.map(page => page.href)));
// Vercel serves 404.html with status 404 for any path without a file. "Did you mean" draws on the sitemap's pages.
const notFoundTemplate = renderMarketingCopy(await readFile(resolve(root, "404.html"), "utf8"));
if (notFoundTemplate.split(footerMarker).length !== 2) throw new Error("Expected one shared footer slot in 404.html.");
const notFoundRoutes = [...STATIC_PAGES, { href: BLOG_PATH, label: "Blog" }, ...indexablePosts().map(post => ({ href: post.path, label: routeLabel(post.title) }))];
const notFound = notFoundTemplate.replace("{{STATUS_PAGE}}", renderNotFound(notFoundRoutes));
if (/\{\{[A-Z_]+\}\}/.test(notFound)) throw new Error("Unresolved content slot in 404.html");
await writeFile(resolve(output, "404.html"), withAnalytics(notFound.replace(footerMarker, supportFooter()), true));
await writeFile(resolve(output, "llms.txt"), (await readFile(resolve(root, "llms.txt"), "utf8")).trimEnd() + "\n" + renderLlmsSection());
for (const archive of ["pilot-v0", "v2-calibration-0", "frontier-v0", "agent-v0", "admissions-opus5-2026-09-19"]) await cp(resolve(root, `benchmark/${archive}`), resolve(output, `benchmark/${archive}`), { recursive: true });
await writeFile(resolve(output, "benchmark/v2-calibration-0/profiles.json"), JSON.stringify({ schemaVersion: 1, suiteHash: v2.suiteHash, profiles: CAPABILITY_PROFILES, models: profileReport(v2) }, null, 2) + "\n");
await cp(fileURLToPath(import.meta.resolve("@hraness/site-footer/stylex.css")), resolve(output, "footer.css"));
await cp(resolve(root, "launch/mockups.css"), resolve(output, "launch-mockups.css"));
await cp(resolve(root, "media"), resolve(output, "media"), { recursive: true }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
const files = ["mockups.css", "plain-publication.css", "paper-theme.css", "palette-system.css", "palette-bridge.css", "syntax-highlighting.css", "typography.css", "product-marketing.css", "product-marketing-preset.css", "lantern-material.css", "appearance-menu.css", "status-page.css", "site-shell.css", "fonts.css"];
for (const name of files) await cp(resolve(kit, name), resolve(output, "design", name));
await cp(resolve(kit, "fonts/nebula-sans"), resolve(output, "design/fonts/nebula-sans"), { recursive: true });
await cp(resolve(kit, "fonts/instrument-serif"), resolve(output, "design/fonts/instrument-serif"), { recursive: true });
await cp(resolve(kit, "fonts/geist-mono"), resolve(output, "design/fonts/geist-mono"), { recursive: true });
await cp(resolve(kit, "marketing-assets"), resolve(output, "design/marketing-assets"), { recursive: true });
await cp(resolve(kit, "../LICENSE"), resolve(output, "design/LICENSE"));
const result = await Bun.build({ entrypoints: [resolve(root, "appearance.ts")], outdir: output, naming: "appearance.js", target: "browser", format: "iife", minify: true });
if (!result.success) throw new AggregateError(result.logs, "Appearance bundle failed");
const practice = await Bun.build({ entrypoints: [resolve(root, "practice.ts")], outdir: output, naming: "practice.js", target: "browser", format: "iife", minify: true });
if (!practice.success) throw new AggregateError(practice.logs, "Practice bundle failed");
const socialKitCopy = await Bun.build({ entrypoints: [resolve(root, "social-kit-copy.ts")], outdir: output, naming: "social-kit-copy.js", target: "browser", format: "iife", minify: true });
if (!socialKitCopy.success) throw new AggregateError(socialKitCopy.logs, "Social kit bundle failed");
const statusPage = await Bun.build({ entrypoints: [resolve(root, "status-page.ts")], outdir: output, naming: "status-page.js", target: "browser", format: "iife", minify: true });
if (!statusPage.success) throw new AggregateError(statusPage.logs, "Status page bundle failed");
const pkg = JSON.parse(await readFile(resolve(kit, "../package.json"), "utf8"));
await writeFile(resolve(output, "design/source.json"), JSON.stringify({ package: pkg.name, version: pkg.version, files: Object.fromEntries(await Promise.all(files.map(async name => [name, createHash("sha256").update(await readFile(resolve(output, "design", name))).digest("hex")]))) }, null, 2));
console.log(`Built Clankdar (${pages.length + blogPages.length + 1} pages) with ${pkg.name}@${pkg.version}.`);

const analytics = await Bun.build({ entrypoints: [resolve(root, "analytics.ts")], outdir: output, naming: "analytics.js", target: "browser", format: "iife", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
if (!analytics.success) throw new AggregateError(analytics.logs, "Analytics bundle failed");
