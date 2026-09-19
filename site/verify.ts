import { renderActorProfile, renderCampaignProfile } from "../cloudflare/src/public.ts";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values } = parseArgs({ args: process.argv.slice(2), options: { channel: { type: "string" } }, strict: true, allowPositionals: false });
if (values.channel && !["chrome", "chromium"].includes(values.channel)) throw new Error("channel must be chrome or chromium");
const root = resolve(import.meta.dir, "dist");
const files = new Set(new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true }));
if (!files.has("index.html")) throw new Error("build the site before browser verification");
const config = JSON.parse(readFileSync(resolve(import.meta.dir, "../vercel.json"), "utf8"));
const headers = Object.fromEntries(config.headers[0].headers.map((header: { key: string; value: string }) => [header.key, header.value]));
const fixtureAddress = `clank1_${"a".repeat(27)}`;
const fixtureCampaign = { campaignId: `cmp_${"b".repeat(16)}`, policyId: "v2-floor-v1", epochs: 24, cadenceSeconds: 3600, windowSeconds: 120, startsAt: "2026-09-19T00:00:00Z", scheduleCommit: "c".repeat(64), evidence: { scheduled: 24, completed: 5, missed: 2, admitted: 4, challengesPassed: 17 } };
const fixtureActor = { address: fixtureAddress, publicKey: "d".repeat(43), createdAt: "2026-09-18T00:00:00Z", evidence: { campaigns: 1, heartbeats: 0 }, campaigns: [fixtureCampaign], claims: { automatedAvailability: { completed: 5, missed: 2 }, capability: { admitted: 4, epochs: 5 } }, head: { seq: 16, eventHash: "e".repeat(64) } };
const profilePaths = [`/actors/${fixtureAddress}`, `/actors/${fixtureAddress}/campaigns/${fixtureCampaign.campaignId}`];
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === profilePaths[0]) return renderActorProfile(fixtureActor);
    if (pathname === profilePaths[1]) return renderCampaignProfile(fixtureCampaign, fixtureAddress, [{ epoch: 0, status: "decided", verdict: true, evidenceHash: "f".repeat(64) }, { epoch: 1, status: "missed" }]);
    if (pathname === "/profile.css") return new Response(Bun.file(resolve(import.meta.dir, "../cloudflare/profile.css")), { headers: { ...headers, "content-type": "text/css" } });
    let path = pathname.slice(1);
    if (!path || path.endsWith("/")) path += "index.html";
    else if (!path.includes(".")) path += "/index.html";
    if (!files.has(path)) return new Response("Not found", { status: 404, headers });
    return new Response(Bun.file(resolve(root, path)), { headers });
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const screenshots = resolve(import.meta.dir, `../results/visual-${randomUUID()}`);
mkdirSync(screenshots, { recursive: true });
let browser: Browser | undefined;
let activePage: Page | undefined;
const errors: string[] = [];
let checked = 0;
try {
  browser = await chromium.launch({ channel: values.channel, headless: true });
  for (const width of [1280, 390, 320]) {
    for (const theme of ["light", "dark"] as const) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce", serviceWorkers: "block" });
      await context.route("**/*", (route) => {
        if (new URL(route.request().url()).origin !== origin) { errors.push("unexpected third-party request"); return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage();
      activePage = page;
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      page.on("response", (response) => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
      for (const path of ["/", "/docs/", "/benchmark/", ...profilePaths]) {
        await page.goto(origin + path, { waitUntil: "networkidle" });
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
        if (path === "/") {
          await page.locator(".answer-reveal summary").click();
          await expect(page.locator(".answer-reveal code")).toHaveText("rednoy");
          await page.locator(".answer-reveal summary").click();
        }
        const slug = path === "/" ? "home" : profilePaths.includes(path) ? (path === profilePaths[0] ? "actor" : "campaign") : path.replaceAll("/", "");
        await page.screenshot({ path: resolve(screenshots, `${slug}-${width}-${theme}.png`), fullPage: path === "/" });
        if (path === "/benchmark/") {
          const v2 = page.locator("#v2-results .results-table").first();
          await expect(v2.locator("tbody tr")).toHaveCount(5);
          await v2.scrollIntoViewIfNeeded();
          await page.screenshot({ path: resolve(screenshots, `v2-table-${width}-${theme}.png`) });
          const profiles = page.locator("#profiles .profile-table");
          await expect(profiles.locator("tbody tr")).toHaveCount(5);
          await profiles.screenshot({ path: resolve(screenshots, `profiles-table-${width}-${theme}.png`) });
          const pilot = page.locator("#pilot-results .results-table").first();
          await expect(pilot.locator("tbody tr")).toHaveCount(12);
        }
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
      await context.close();
    }
  }
  const noScript = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await noScript.newPage();
  activePage = page;
  await page.goto(origin);
  await page.locator(".answer-reveal summary").click();
  await expect(page.locator(".answer-reveal code")).toBeVisible();
  await page.goto(origin + "/benchmark/");
  await expect(page.locator("#pilot-results .results-table").first()).toBeVisible();
  await noScript.close();
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ pagesChecked: checked, widths: [1280, 390, 320], themes: ["light", "dark"], noScript: true, browserErrors: errors.length, screenshots }, null, 2));
} catch (error) {
  if (activePage && !activePage.isClosed()) await activePage.screenshot({ path: resolve(screenshots, "failure.png") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  server.stop(true);
}
