import { renderActorProfile, renderCampaignProfile } from "../cloudflare/src/public.ts";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { POSTS } from "./blog/articles.ts";
import { articleRelatedProducts } from "./portfolio-marks";
import { ownedChromiumLaunchOptions, parseBrowserVerificationArgs, pinnedChromiumDefinition, verifyOwnedChromium } from "./browser-launch.ts";
import { classifyVerificationRequest } from "./verification-network.ts";
import { verifyPublicationLinks } from "./verify-publication-links.mjs";

const values = parseBrowserVerificationArgs(process.argv.slice(2));
const { concurrency } = values;
const definition = pinnedChromiumDefinition();
const launchOptions = ownedChromiumLaunchOptions(chromium.executablePath(), definition.defaultArgs);
const root = resolve(import.meta.dir, "dist");
const files = new Set(values.production ? [] : new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true }));
if (!values.production && !files.has("index.html")) throw new Error("build the site before browser verification");
const config = JSON.parse(readFileSync(resolve(import.meta.dir, "../vercel.json"), "utf8"));
const headers = Object.fromEntries(config.headers[0].headers.map((header: { key: string; value: string }) => [header.key, header.value]));
const fixtureAddress = `clank1_${"a".repeat(27)}`;
const fixtureCampaign = { campaignId: `cmp_${"b".repeat(16)}`, policyId: "v2-floor-v1", epochs: 24, cadenceSeconds: 3600, windowSeconds: 120, startsAt: "2026-09-19T00:00:00Z", scheduleCommit: "c".repeat(64), evidence: { scheduled: 24, completed: 5, missed: 2, admitted: 4, challengesPassed: 17 } };
const fixtureActor = { address: fixtureAddress, publicKey: "d".repeat(43), createdAt: "2026-09-18T00:00:00Z", evidence: { campaigns: 1, heartbeats: 0 }, campaigns: [fixtureCampaign], claims: { automatedAvailability: { completed: 5, missed: 2 }, capability: { admitted: 4, epochs: 5 } }, head: { seq: 16, eventHash: "e".repeat(64) } };
const profilePaths = [`/actors/${fixtureAddress}`, `/actors/${fixtureAddress}/campaigns/${fixtureCampaign.campaignId}`];
const blogPaths = ["/blog/", "/blog/introducing-clankdar", "/blog/how-clankdar-uses-algal"];
// A missing address, and a mistyped real one that earns "Did you mean".
const missingPaths: readonly [string, string | undefined][] = [["/this-page-does-not-exist", undefined], ["/benchmarks/", "/benchmark/"]];
// Production captures are bounded to the public marketing origin; actor fixtures stay local.
const server = values.production ? undefined : Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === profilePaths[0]) return renderActorProfile(fixtureActor);
    if (pathname === profilePaths[1]) return renderCampaignProfile(fixtureCampaign, fixtureAddress, [{ epoch: 0, status: "decided", verdict: true, evidenceHash: "f".repeat(64) }, { epoch: 1, status: "missed" }]);
    if (pathname === "/profile.css") return new Response(Bun.file(resolve(import.meta.dir, "../cloudflare/profile.css")), { headers: { ...headers, "content-type": "text/css" } });
    let path = pathname.slice(1);
    if (!path || path.endsWith("/")) path += "index.html";
    else if (!path.includes(".")) path += files.has(`${path}.html`) ? ".html" : "/index.html";
    // Vercel answers a path without a file with 404.html and status 404.
    if (!files.has(path)) return new Response(Bun.file(resolve(root, "404.html")), { status: 404, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
    return new Response(Bun.file(resolve(root, path)), { headers });
  },
});
const origin = values.production ? "https://clankdar.com" : `http://127.0.0.1:${server!.port}`;
const screenshots = resolve(import.meta.dir, `../results/visual-${randomUUID()}`);
mkdirSync(screenshots, { recursive: true });
const widths = [1440, 1280, 608, 390, 360, 320];
let browser: Browser | undefined;
let activePage: Page | undefined;
const errors: string[] = [];
let checked = 0;
const publicationLinks: { width: number; theme: string; path: string; groups: unknown[] }[] = [];
let browserIdentity: { executable: string; browserVersion: string } | undefined;

async function verifyChrome(page: Page, width: number): Promise<void> {
  const geometry = () => page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height, center: rect.top + rect.height / 2, position: getComputedStyle(element).position };
    };
    return {
      header: box(".masthead"), brand: box(".masthead .wordmark"), nav: box(".masthead .site-nav"),
      appearance: box(".masthead [data-hraness-appearance-menu] > button"),
      footer: box("#hraness-site-footer .hraness-site-footer__inner"), viewportHeight: innerHeight, scrollY,
      footerFootprint: document.querySelector("#hraness-site-footer")!.getBoundingClientRect().height,
    };
  });
  const initial = await geometry();
  if (width > 960) {
    const sectionOffsets = await page.locator(".section").evaluateAll((sections) => sections.flatMap((section) => {
      const heading = section.querySelector(":scope > .section-head");
      const body = section.querySelector(":scope > .section-body");
      return heading && body ? [Math.abs(heading.getBoundingClientRect().top - body.getBoundingClientRect().top)] : [];
    }));
    for (const offset of sectionOffsets) expect(offset).toBeLessThanOrEqual(2);
  }
  expect(initial.header.position).toBe("sticky");
  expect(initial.header.top).toBeCloseTo(0, 0);
  expect(["static", "relative"]).toContain(initial.footer.position);
  expect(initial.footer.top).toBeGreaterThanOrEqual(initial.header.bottom);
  expect(initial.footerFootprint).toBeGreaterThanOrEqual(initial.footer.height - 1);
  expect(Math.abs(initial.brand.center - initial.appearance.center)).toBeLessThanOrEqual(2);
  expect(initial.appearance.right).toBeGreaterThan(initial.brand.right);
  expect(initial.header.height).toBeLessThanOrEqual(width <= 768 ? 112 : 80);
  await expect(page.locator(".masthead .site-nav a")).toHaveText(["Docs", "Benchmark", "Blog", "GitHub"]);
  if (width <= 768) {
    expect(initial.nav.top).toBeGreaterThanOrEqual(initial.appearance.bottom);
    expect(initial.nav.left).toBeCloseTo(initial.brand.left, 0);
  } else expect(Math.abs(initial.nav.center - initial.appearance.center)).toBeLessThanOrEqual(2);

  await page.evaluate(() => scrollTo(0, 650));
  await expect.poll(async () => (await geometry()).scrollY).toBeGreaterThan(0);
  const scrolled = await geometry();
  expect(scrolled.header.top).toBeCloseTo(0, 0);
  expect(scrolled.footer.top + scrolled.scrollY).toBeCloseTo(initial.footer.top + initial.scrollY, 0);

  const anchor = page.locator("#main h2[id], #main section[id]").first();
  const anchorId = await anchor.getAttribute("id");
  expect(anchorId).toBeTruthy();
  await page.evaluate((id) => document.getElementById(id!)!.scrollIntoView({ block: "start" }), anchorId);
  await expect.poll(async () => (await anchor.boundingBox())!.y - (await geometry()).header.bottom).toBeGreaterThanOrEqual(8);

  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => {
    const footer = document.querySelector("#hraness-site-footer")!;
    return footer.querySelector(".hraness-site-footer__inner")!.getBoundingClientRect().top - footer.previousElementSibling!.getBoundingClientRect().bottom;
  })).toBeGreaterThanOrEqual(-1);
  await page.evaluate(() => scrollTo(0, 0));
}

// One width/theme pass in its own isolated context. Passes run through a small pool.
async function verifyContext(browser: Browser, width: number, theme: "light" | "dark"): Promise<void> {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : width <= 360 ? 740 : 900 }, colorScheme: theme, reducedMotion: "reduce", serviceWorkers: "block" });
  let consentRegionReads = 0;
  await context.route("**/*", (route) => {
    const kind = classifyVerificationRequest(route.request().url(), route.request().method(), origin);
    // The shared footer reads a public region policy on production hosts. Hold
    // consent unaccepted so this run must never send analytics or load an SDK.
    if (kind === "consent-region") {
      consentRegionReads += 1;
      return route.fulfill({
        status: 200, contentType: "application/json",
        headers: { "access-control-allow-origin": origin },
        body: JSON.stringify({ region: "DE", required: true }),
      });
    }
    if (kind === "blocked") { errors.push("unexpected third-party request"); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  try {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      // Chrome logs the 404 document itself; the missing-path checks expect that status.
      const source = message.location().url ? new URL(message.location().url).pathname : "";
      if (message.type() === "error" && !missingPaths.some(([missing]) => missing.replace(/\/$/u, "") === source.replace(/\/$/u, ""))) errors.push(message.text());
    });
    page.on("response", (response) => {
      const pathname = new URL(response.url()).pathname;
      if (response.status() >= 400 && !missingPaths.some(([missing]) => missing.replace(/\/$/u, "") === pathname.replace(/\/$/u, ""))) errors.push(`HTTP ${response.status()} ${pathname}`);
    });
    for (const path of ["/", "/docs/", "/benchmark/", ...blogPaths, ...(values.production ? [] : profilePaths)]) {
      await page.goto(origin + path, { waitUntil: "load" });
      if (values.production && path === "/") await expect.poll(() => consentRegionReads).toBeGreaterThan(0);
      await page.evaluate(async () => { await document.fonts.ready; });
      await expect(page).toHaveTitle(/Clankdar/);
      await expect(page.locator("html")).toHaveAttribute("data-hraness-theme", "paper");
      expect(await page.locator("body").evaluate((body) => getComputedStyle(body).fontFamily)).toContain("Nebula Sans");
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page.locator("#hraness-site-footer")).toHaveCount(1);
      if (!profilePaths.includes(path)) await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `https://clankdar.com${path}`);
      else await expect(page.locator(".record-facts")).toContainText("5 responded · 2 missed");
      expect(await page.locator("form, iframe").count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (width === 1280 && theme === "light" && !profilePaths.includes(path)) {
        const anchors = await page.locator('a[href^="#"]').evaluateAll((links) => links.map((link) => link.getAttribute("href")!.slice(1)));
        for (const id of anchors) expect(await page.locator(`[id="${id}"]`).count()).toBe(1);
        const paths = await page.locator('a[href^="/"]').evaluateAll((links) => [...new Set(links.map((link) => link.getAttribute("href")!.split("#")[0]))]);
        for (const href of paths) expect((await context.request.get(origin + href)).status()).toBe(200);
      }
      await verifyChrome(page, width);
      if (path === "/") {
        const choices = page.locator("[data-practice-answer]");
        await expect(page.locator("[data-practice-next]")).toBeHidden();
        await choices.filter({ hasText: /^34$/ }).click();
        await expect(page.locator("[data-practice-feedback]")).toContainText("Correct. The answer is 34.");
        for (const choice of await choices.all()) await expect(choice).toBeDisabled();
        await expect(page.locator("[data-practice-next] a")).toHaveAttribute("href", "/docs/#quickstart");
        await page.locator("[data-practice-another]").click();
        await expect(page.locator("[data-practice-values]")).toHaveText("values = [2,4,1,3]");
        await choices.filter({ hasText: /^16$/ }).click();
        await expect(page.locator("[data-practice-feedback]")).toContainText("doesn’t match");
        await expect(page.locator("[data-practice-feedback]")).toContainText("25");
        await page.locator(".room .answer-reveal summary").click();
        await expect(page.locator("[data-practice-solution]")).toHaveText("25");
        await page.locator("[data-practice-another]").click();
        await expect(choices.first()).toBeFocused();
        // Practice controls scroll into view; capture sticky chrome from the page top.
        await page.evaluate(() => scrollTo(0, 0));
        await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
      }
      const slug = path === "/" ? "home" : profilePaths.includes(path) ? (path === profilePaths[0] ? "actor" : "campaign") : path.replaceAll("/", "");
      await page.screenshot({ path: resolve(screenshots, `${slug}-${width}-${theme}.png`), fullPage: path === "/" });
      if (path.startsWith("/blog/")) {
        await expect(page.locator(".plain-publication")).toHaveCount(1);
        if (path !== "/blog/") {
          if (path === "/blog/introducing-clankdar" && (width === 390 || width === 1440)) {
            publicationLinks.push({ width, theme, path, groups: await verifyPublicationLinks(page, [
              { name: "article", selector: ".plain-publication__article-body a[href]:not([role='button'], [data-emphasis], [data-foil])" },
              { name: "sources", selector: ".plain-publication__sources a[href]" },
            ]) });
          }
          const marks = page.locator(".plain-publication__related-mark");
          await expect(marks).toHaveCount(articleRelatedProducts.length);
          for (const [index, item] of articleRelatedProducts.entries()) {
            await expect(marks.nth(index)).toHaveAttribute("src", item.mark);
            await expect.poll(() => marks.nth(index).evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
          }
          await page.locator(".plain-publication__related").screenshot({ path: resolve(screenshots, `${slug}-related-${width}-${theme}.png`) });
          await expect(page.locator(".plain-publication__byline")).toHaveText("By Hraness");
          const reviewer = POSTS.find(post => post.path === path.replace(/\/$/u, ""))?.admission.review?.reviewer;
          if (reviewer === undefined) throw new Error(`No review record for ${path}`);
          await expect(page.locator(".plain-publication__provenance")).toHaveText(`Drafted with AI from the source code and reviewed by ${reviewer}.`);
          await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
        }
      }
      if (path === "/benchmark/") {
        const comparison = page.locator("#results .benchmark-snapshot");
        await expect(comparison.locator("tbody tr")).toHaveCount(5);
        await expect(comparison).toContainText("437/499");
        await expect(page.locator("table:visible")).toHaveCount(1);
        await comparison.scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve(screenshots, `benchmark-table-${width}-${theme}.png`) });
        const method = page.locator("#method > details").first();
        await method.locator("summary").click();
        await expect(method.locator('a[href$="/report.json"]')).toBeVisible();
        await method.locator("summary").click();
        const archive = page.locator("#archive");
        await archive.locator("summary").click();
        await expect(archive.locator('a[href="/benchmark/agent-v0/manifest.json"]')).toBeVisible();
      }
      checked++;
    }
    for (const [path, suggestion] of missingPaths) {
      const response = await page.goto(origin + path, { waitUntil: "load" });
      expect(response!.status()).toBe(404);
      await expect(page).toHaveTitle("Page not found · Clankdar");
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
      await expect(page.locator("h1")).toHaveText("We can’t find that page");
      await expect(page.locator(".hraness-status-page__action")).toHaveAttribute("href", "/docs/#quickstart");
      await expect(page.locator(".hraness-status-page__next-link")).toHaveCount(3);
      await expect(page.locator(".hraness-status-page")).toHaveAttribute("data-hraness-status-field", "live");
      const hint = page.locator(".hraness-status-page__hint");
      if (suggestion === undefined) await expect(hint).toBeHidden();
      else await expect(hint.locator("a")).toHaveAttribute("href", suggestion);
      await expect(page.locator("#hraness-site-footer")).toHaveCount(1);
      await expect(page.locator(".masthead .site-nav a")).toHaveText(["Docs", "Benchmark", "Blog", "GitHub"]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: resolve(screenshots, `not-found${suggestion === undefined ? "" : "-hint"}-${width}-${theme}.png`) });
      checked++;
    }
    if (width === 1280 && theme === "light") {
      await page.goto(origin);
      const trigger = page.locator("[data-hraness-appearance-menu] > button");
      const before = await page.locator('meta[name="theme-color"][data-hraness-design-theme-color-sync-active]').getAttribute("content");
      await trigger.click();
      await page.locator('[role="menuitemradio"][data-theme-value="dark"]').click();
      await expect(page.locator('[role="menuitemradio"][data-theme-value="dark"]')).toHaveAttribute("aria-checked", "true");
      expect(await page.locator('meta[name="theme-color"][data-hraness-design-theme-color-sync-active]').getAttribute("content")).not.toBe(before);
      await trigger.focus();
      await trigger.press("Enter");
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(trigger).toBeFocused();
    }
  } catch (error) {
    if (!page.isClosed()) await page.screenshot({ path: resolve(screenshots, `failure-${width}-${theme}.png`) }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

try {
  browser = await chromium.launch(launchOptions);
  browserIdentity = await verifyOwnedChromium(browser, launchOptions.executablePath, definition.expectedVersion);
  console.log(JSON.stringify(browserIdentity));
  const passes = widths.flatMap((width) => (["light", "dark"] as const).map((theme) => ({ width, theme })));
  let next = 0;
  let failure: unknown;
  // Stop handing out passes after the first failure, let running passes finish, then report it.
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < passes.length) {
      const { width, theme } = passes[next++]!;
      try { await verifyContext(browser!, width, theme); }
      catch (error) { failure ??= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, passes.length) }, worker));
  if (failure !== undefined) throw failure;
  const noScript = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await noScript.newPage();
  activePage = page;
  // No-script entry path: open the practice room by its fragment; the anchor clears both sticky bars.
  await page.goto(origin + "/#try");
  await page.locator(".room .answer-reveal summary").click();
  await expect(page.locator("[data-practice-solution]")).toBeVisible();
  await expect(page.locator("[data-practice-controls]")).toBeHidden();
  await page.goto(origin + "/benchmark/");
  await expect(page.locator("#results .benchmark-snapshot")).toBeVisible();
  await page.locator("#method > details").first().locator("summary").click();
  await expect(page.locator('#method a[href$="/report.json"]')).toBeVisible();
  await noScript.close();
  expect(errors).toEqual([]);
  const report = { capturedAt: new Date().toISOString(), origin, mode: values.production ? "production" : "local", consent: values.production ? "required-unaccepted" : "not-applicable-local", ...browserIdentity, pagesChecked: checked, widths, themes: ["light", "dark"], noScript: true, browserErrors: errors.length, publicationLinks, screenshots };
  writeFileSync(resolve(screenshots, "verification.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: resolve(screenshots, "failure.png") }).catch(() => {});
  throw error;
} finally {
  try { await browser?.close(); }
  finally { server?.stop(true); }
}
