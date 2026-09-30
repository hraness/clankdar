import type { Browser, LaunchOptions } from "@playwright/test";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
const requiredDisabledFeatures = ["PaintHolding", "MacAppCodeSignClone"];

export function parseBrowserVerificationArgs(args: string[]): { production: boolean; concurrency: number } {
  const { values } = parseArgs({ args, options: { production: { type: "boolean", default: false }, concurrency: { type: "string", default: "2" } }, strict: true, allowPositionals: false });
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) throw new Error("concurrency must be an integer from 1 to 12");
  return { production: values.production!, concurrency };
}

export function parseIconGenerationArgs(args: string[]): void {
  parseArgs({ args, options: {}, strict: true, allowPositionals: false });
}

export function pinnedChromiumDefinition(): { defaultArgs: string[]; expectedVersion: string } {
  const coreRoot = dirname(require.resolve("playwright-core/package.json"));
  const installedVersion = JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf8")).version;
  const pinnedVersion = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).devDependencies["@playwright/test"];
  if (installedVersion !== pinnedVersion) throw new Error("Install the repository's pinned Playwright version before browser verification");
  const browser = JSON.parse(readFileSync(join(coreRoot, "browsers.json"), "utf8")).browsers.find((entry: { name: string }) => entry.name === "chromium");
  // The exact pinned package supplies the complete headless switches, including
  // audio: preserve them when replacing its disable-features argument.
  const { createPlaywright } = require(join(coreRoot, "lib/server/playwright.js"));
  const formatter = createPlaywright?.({ sdkLanguage: "javascript" }).chromium;
  if (typeof formatter?._innerDefaultArgs !== "function" || typeof browser?.browserVersion !== "string") throw new Error("Cannot reconcile the pinned Playwright Chromium definition");
  const defaultArgs: unknown = formatter._innerDefaultArgs({ headless: true });
  if (!Array.isArray(defaultArgs) || !defaultArgs.every((arg) => typeof arg === "string")) throw new Error("Cannot reconcile the pinned Playwright Chromium switches");
  return { defaultArgs, expectedVersion: browser.browserVersion };
}

function rejectInstalledChrome(path: string): void {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (/\/google chrome(?: beta| dev| canary)?\.app\//u.test(normalized) ||
      /\/opt\/google\/chrome(?:-beta|-unstable)?\//u.test(normalized) ||
      /\/google\/chrome(?: beta| dev| sxs)?\/application\//u.test(normalized)) {
    throw new Error("Installed Google Chrome is not permitted for owned browser verification");
  }
}

export function ownedChromiumLaunchOptions(executablePath: string, defaultArgs: readonly string[], args: readonly string[] = []): LaunchOptions & { executablePath: string } {
  rejectInstalledChrome(executablePath);
  let executable: string;
  try {
    executable = realpathSync(executablePath);
    rejectInstalledChrome(executable);
    if (!statSync(executable).isFile()) throw new Error("Chromium executable is not a regular file");
    accessSync(executable, constants.X_OK);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Installed Google Chrome")) throw error;
    throw new Error("Provision Chromium first: bunx --no-install playwright install chromium", { cause: error });
  }
  if (!resolve(executablePath).split(/[\\/]/u).some((part) => /^chromium-\d+$/u.test(part)) ||
      !executable.split(/[\\/]/u).some((part) => /^chromium-\d+$/u.test(part))) {
    throw new Error("Browser verification requires the Chromium provisioned for pinned Playwright");
  }
  const defaults = defaultArgs.filter((arg) => arg.startsWith("--disable-features="));
  if (defaults.length !== 1) throw new Error("Cannot reconcile pinned Playwright's disable-features switch");
  const supplied = args.filter((arg) => arg.startsWith("--disable-features="));
  if (args.includes("--disable-features")) throw new Error("Use --disable-features=value for Chromium features");
  const features = [...new Set([...defaults, ...supplied].flatMap((arg) => arg.slice("--disable-features=".length).split(",")).map((feature) => feature.trim()).filter(Boolean).concat(requiredDisabledFeatures))];
  const mergedFeatures = `--disable-features=${features.join(",")}`;
  const useDefaultFeatures = mergedFeatures === defaults[0];
  return { executablePath: executable, headless: true,
    // Playwright filters the complete command line, including supplied args.
    ignoreDefaultArgs: useDefaultFeatures ? [] : defaults,
    args: [...args.filter((arg) => !arg.startsWith("--disable-features=") && arg !== "--mute-audio"), ...(defaultArgs.includes("--mute-audio") ? [] : ["--mute-audio"]), ...(useDefaultFeatures ? [] : [mergedFeatures])] };
}

export async function verifyOwnedChromium(browser: Browser, executablePath: string, expectedVersion: string): Promise<{ executable: string; browserVersion: string }> {
  const browserVersion = browser.version();
  if (browserVersion !== expectedVersion) throw new Error(`Provisioned Chromium version mismatch: expected ${expectedVersion}, got ${browserVersion}`);
  const session = await browser.newBrowserCDPSession();
  try {
    const { arguments: args } = await session.send("Browser.getBrowserCommandLine");
    if (realpathSync(args[0]!) !== executablePath) throw new Error("Chromium did not launch the resolved provisioned executable");
    const disabled = args.filter((arg) => arg.startsWith("--disable-features="));
    if (disabled.length !== 1 || !requiredDisabledFeatures.every((feature) => disabled[0]!.slice("--disable-features=".length).split(",").includes(feature))) throw new Error("Owned Chromium must merge the required disabled features into one switch");
    if (!args.includes("--mute-audio")) throw new Error("Owned Chromium must mute audio");
  } finally {
    await session.detach();
  }
  return { executable: executablePath, browserVersion };
}
