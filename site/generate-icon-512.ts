// Renders icon-512.png from icons/clankdar.svg. Share images come from site/social.ts.
// Usage: bun site/generate-icon-512.ts (after provisioning pinned Playwright Chromium)
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { ownedChromiumLaunchOptions, parseIconGenerationArgs, pinnedChromiumDefinition, verifyOwnedChromium } from "./browser-launch.ts";

const root = import.meta.dir;
parseIconGenerationArgs(process.argv.slice(2));
// The traced mark carries two full-height hairline bars at its left and right
// edges. They vanish at favicon size but frame the mark at raster sizes, so the
// rendered PNG omits them. The SVG itself stays as the brand catalog ships it.
const edgeBar = /<path d="M0 0 C[\d. ]+ 0 [\d. ]+ 0 [\d.]+ 0 C[\d.]+ 253\.44 [\d.]+ 506\.88 [\d.]+ 768 C[^"]*Z "[^>]*\/>\s*/g;
const source = await readFile(resolve(root, "icons/clankdar.svg"), "utf8");
const svg = source.replace(edgeBar, "");
if (source.match(edgeBar)?.length !== 2) throw new Error("Expected exactly two edge bars in icons/clankdar.svg.");

const iconHtml = `<!doctype html><html><head><style>
html, body { margin: 0; background: transparent; }
svg { display: block; width: 512px; height: 512px; }
</style></head><body>${svg}</body></html>`;

const definition = pinnedChromiumDefinition();
const launchOptions = ownedChromiumLaunchOptions(chromium.executablePath(), definition.defaultArgs);
const browser = await chromium.launch(launchOptions);
try {
  console.log("owned_browser", JSON.stringify(await verifyOwnedChromium(browser, launchOptions.executablePath, definition.expectedVersion)));
  const icon = await browser.newPage({ viewport: { width: 512, height: 512 } });
  try {
    await icon.setContent(iconHtml);
    await icon.screenshot({ path: resolve(root, "icon-512.png"), omitBackground: true });
  } finally {
    await icon.close();
  }
} finally {
  await browser.close();
}
console.log("Wrote site/icon-512.png.");
