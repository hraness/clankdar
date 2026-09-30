// Renders all favicon variants from the header mark in marks/clankdar.svg. Share images come from site/social.ts.
// Usage: bun site/generate-icon-512.ts (after provisioning pinned Playwright Chromium)
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { ownedChromiumLaunchOptions, parseIconGenerationArgs, pinnedChromiumDefinition, verifyOwnedChromium } from "./browser-launch.ts";

const root = import.meta.dir;
parseIconGenerationArgs(process.argv.slice(2));
// Derive every browser/touch variant from the actual header mark. Keep the
// vector aspect ratio, remove the source canvas margin, and paint only white.
const source = await readFile(resolve(root, "marks/clankdar.svg"), "utf8");
const svg = source.replace(/fill="(?!none)[^"]*"/gu, 'fill="#ffffff"');
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
    await icon.evaluate(() => {
      const mark = document.querySelector("svg")!;
      const box = mark.getBBox();
      const side = Math.max(box.width, box.height);
      mark.setAttribute("viewBox", `${box.x + (box.width - side) / 2} ${box.y + (box.height - side) / 2} ${side} ${side}`);
      mark.setAttribute("width", "512");
      mark.setAttribute("height", "512");
    });
    await writeFile(resolve(root, "favicon.svg"), `${await icon.locator("svg").evaluate(mark => mark.outerHTML)}\n`);
    for (const [name, size] of [["icon.png", 32], ["icon-512.png", 512], ["apple-icon.png", 180]] as const) {
      await icon.setViewportSize({ width: size, height: size });
      await icon.evaluate(({ size, black }) => {
        document.body.style.background = black ? "#000000" : "transparent";
        const mark = document.querySelector("svg")!;
        mark.style.width = `${size}px`;
        mark.style.height = `${size}px`;
      }, { size, black: name === "apple-icon.png" });
      await icon.screenshot({ path: resolve(root, name), omitBackground: name !== "apple-icon.png" });
    }
  } finally {
    await icon.close();
  }
} finally {
  await browser.close();
}
console.log("Wrote the white centered browser and Apple touch icons.");
