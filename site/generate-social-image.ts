// Renders icon-512.png and og.png from icons/clankdar.svg.
// Usage: bun site/generate-social-image.ts [--channel chrome]
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = import.meta.dir;
const channelIndex = process.argv.indexOf("--channel");
const channel = channelIndex === -1 ? undefined : process.argv[channelIndex + 1];
const kit = dirname(fileURLToPath(import.meta.resolve("@hraness/design-kit/paper-theme.css")));
// The traced mark carries two full-height hairline bars at its left and right
// edges. They vanish at favicon size but frame the mark at raster sizes, so the
// rendered PNGs omit them. The SVG itself stays as the brand catalog ships it.
const edgeBar = /<path d="M0 0 C[\d. ]+ 0 [\d. ]+ 0 [\d.]+ 0 C[\d.]+ 253\.44 [\d.]+ 506\.88 [\d.]+ 768 C[^"]*Z "[^>]*\/>\s*/g;
const source = await readFile(resolve(root, "icons/clankdar.svg"), "utf8");
const svg = source.replace(edgeBar, "");
if (source.match(edgeBar)?.length !== 2) throw new Error("Expected exactly two edge bars in icons/clankdar.svg.");
const font = async (weight: string) => (await readFile(resolve(kit, `fonts/nebula-sans/NebulaSans-${weight}.woff2`))).toString("base64");
const [book, semibold] = await Promise.all([font("Book"), font("Semibold")]);

const iconHtml = `<!doctype html><html><head><style>
html, body { margin: 0; background: transparent; }
svg { display: block; width: 512px; height: 512px; }
</style></head><body>${svg}</body></html>`;

const cardHtml = `<!doctype html><html><head><style>
@font-face { font-family: "Nebula Sans"; font-weight: 400; src: url(data:font/woff2;base64,${book}) format("woff2"); }
@font-face { font-family: "Nebula Sans"; font-weight: 600; src: url(data:font/woff2;base64,${semibold}) format("woff2"); }
html, body { margin: 0; }
body { width: 1200px; height: 630px; background: #f8f7f4; color: #1c1917; font-family: "Nebula Sans", sans-serif; display: flex; align-items: center; gap: 64px; padding: 0 88px; box-sizing: border-box; }
.mark svg { display: block; width: 300px; height: 300px; }
.name { font-size: 36px; font-weight: 600; margin: 0 0 20px; }
h1 { font-size: 64px; line-height: 1.05; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 24px; }
p { font-size: 30px; line-height: 1.3; margin: 0; color: #44403c; }
</style></head><body>
<div class="mark">${svg}</div>
<div><p class="name">Clankdar</p><h1>Check what your agent can solve.</h1><p>Fresh puzzles, exact scoring, and a signed receipt anyone can recheck.</p></div>
</body></html>`;

const browser = await chromium.launch(channel === undefined ? {} : { channel });
try {
  const icon = await browser.newPage({ viewport: { width: 512, height: 512 } });
  await icon.setContent(iconHtml);
  await icon.screenshot({ path: resolve(root, "icon-512.png"), omitBackground: true });
  const card = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await card.setContent(cardHtml);
  await card.evaluate(() => document.fonts.ready);
  await card.screenshot({ path: resolve(root, "og.png") });
} finally {
  await browser.close();
}
console.log("Wrote site/icon-512.png and site/og.png.");
