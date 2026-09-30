import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import { ownedChromiumLaunchOptions, parseBrowserVerificationArgs, parseIconGenerationArgs, pinnedChromiumDefinition, verifyOwnedChromium } from "./browser-launch.ts";

const defaults = ["--disable-features=ExistingFeature,PaintHolding", "--enable-automation"];

function fixture(check: (root: string, executable: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clankdar-browser-selection-")));
  const executable = join(root, "chromium-1234", "chrome");
  mkdirSync(join(root, "chromium-1234"));
  writeFileSync(executable, "fixture; never executed");
  chmodSync(executable, 0o755);
  try { check(root, executable); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

describe("owned browser verification", () => {
  test("CI provisions pinned Playwright Chromium without selecting installed Chrome", () => {
    for (const path of ["check.yml", "verify-production.yml"]) {
      const workflow = readFileSync(join(import.meta.dir, "../.github/workflows", path), "utf8");
      expect(workflow).not.toContain("--channel chrome");
      expect(workflow).toContain("bunx --no-install playwright install --with-deps chromium");
      expect(workflow).toContain("bun run check:browser");
    }
  });

  test("icon generation rejects retired overrides and uses the shared guarded launcher", () => {
    expect(parseIconGenerationArgs([])).toBeUndefined();
    for (const args of [["--channel", "chrome"], ["--executable-path", "/Applications/Google Chrome.app"], ["unexpected"]]) {
      expect(() => parseIconGenerationArgs(args)).toThrow();
    }
    const icon = readFileSync(join(import.meta.dir, "generate-icon-512.ts"), "utf8");
    expect(icon).toContain("parseIconGenerationArgs(process.argv.slice(2))");
    expect(icon).toContain("ownedChromiumLaunchOptions(chromium.executablePath(), definition.defaultArgs)");
    expect(icon).toContain("verifyOwnedChromium(browser, launchOptions.executablePath, definition.expectedVersion)");
    expect(icon).toContain("await icon.close()");
    expect(icon).toContain("await browser.close()");
  });

  test("CLI keeps bounded modes and rejects channel and executable overrides", () => {
    expect(parseBrowserVerificationArgs([])).toEqual({ production: false, concurrency: 2 });
    expect(parseBrowserVerificationArgs(["--production", "--concurrency", "3"])).toEqual({ production: true, concurrency: 3 });
    for (const args of [["--channel", "chrome"], ["--channel", "chromium"], ["--executable-path", "/Applications/Google Chrome.app"], ["--concurrency", "0"], ["--concurrency", "13"], ["unexpected"]]) {
      expect(() => parseBrowserVerificationArgs(args)).toThrow();
    }
  });

  test("installed Chrome paths are rejected before any attempt to launch", () => {
    for (const path of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary", "/opt/google/chrome/chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]) {
      expect(() => ownedChromiumLaunchOptions(path, defaults)).toThrow("Installed Google Chrome");
    }
  });

  test("a versioned cache symlink to installed Chrome is rejected", () => {
    fixture((root, executable) => {
      const installed = join(root, "Google Chrome.app", "Contents", "MacOS", "Google Chrome");
      mkdirSync(join(root, "Google Chrome.app", "Contents", "MacOS"), { recursive: true });
      writeFileSync(installed, "fixture; never executed");
      chmodSync(installed, 0o755);
      rmSync(executable);
      symlinkSync(installed, executable);
      expect(() => ownedChromiumLaunchOptions(executable, defaults)).toThrow("Installed Google Chrome");
    });
  });

  test("missing provisioning and unversioned executable paths never fall back", () => {
    fixture((root, executable) => {
      expect(() => ownedChromiumLaunchOptions(join(root, "missing"), defaults)).toThrow("Provision Chromium first");
      const unversioned = join(root, "chrome");
      writeFileSync(unversioned, "fixture; never executed");
      chmodSync(unversioned, 0o755);
      expect(() => ownedChromiumLaunchOptions(unversioned, defaults)).toThrow("Chromium provisioned for pinned Playwright");
      expect(ownedChromiumLaunchOptions(executable, defaults).executablePath).toBe(executable);
    });
  });

  test("one final feature switch preserves pinned and caller features, with muted audio", () => {
    fixture((_root, executable) => {
      const options = ownedChromiumLaunchOptions(executable, defaults, ["--disable-features=OtherFeature,PaintHolding", "--disable-features=OtherFeature", "--mute-audio", "--no-first-run"]);
      expect(options.channel).toBeUndefined();
      expect(options.headless).toBe(true);
      expect(options.ignoreDefaultArgs).toEqual([defaults[0]!]);
      expect(options.args?.filter((arg) => arg.startsWith("--disable-features="))).toEqual(["--disable-features=ExistingFeature,PaintHolding,OtherFeature,MacAppCodeSignClone"]);
      expect(options.args?.filter((arg) => arg === "--mute-audio")).toHaveLength(1);
      expect(options.args).toContain("--no-first-run");
      expect(() => ownedChromiumLaunchOptions(executable, [])).toThrow("Cannot reconcile");
    });
  });

  test("Playwright's complete-argv filter retains audio and an already compliant default switch", () => {
    fixture((_root, executable) => {
      for (const initial of [defaults, ["--disable-features=PaintHolding,MacAppCodeSignClone"]]) {
        const options = ownedChromiumLaunchOptions(executable, initial);
        const ignored = options.ignoreDefaultArgs as string[];
        const actual = [...initial, ...options.args!].filter((arg) => !ignored.includes(arg));
        expect(actual).toContain("--mute-audio");
        expect(actual.filter((arg) => arg.startsWith("--disable-features="))).toHaveLength(1);
        expect(actual.some((arg) => arg.includes("MacAppCodeSignClone"))).toBe(true);
      }
    });
  });

  test("the installed pinned package supplies its browser version and defaults", () => {
    const definition = pinnedChromiumDefinition();
    expect(definition.expectedVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/u);
    expect(definition.defaultArgs.filter((arg) => arg.startsWith("--disable-features="))).toHaveLength(1);
    expect(definition.defaultArgs).toContain("--enable-automation");
  });

  test("live command-line verification rejects duplicate features and mismatched versions", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "clankdar-browser-identity-")));
    const executable = join(root, "chrome");
    writeFileSync(executable, "fixture; never executed");
    let detached = 0;
    const browser = (args: string[], version = "123.0.0.0") => ({ version: () => version, newBrowserCDPSession: async () => ({ send: async () => ({ arguments: [executable, ...args] }), detach: async () => { detached++; } }) }) as unknown as Browser;
    const safeArgs = ["--mute-audio", "--disable-features=PaintHolding,MacAppCodeSignClone"];
    try {
      expect(await verifyOwnedChromium(browser(safeArgs), executable, "123.0.0.0")).toEqual({ executable, browserVersion: "123.0.0.0" });
      await expect(verifyOwnedChromium(browser([...safeArgs, "--disable-features=OtherFeature"]), executable, "123.0.0.0")).rejects.toThrow("one switch");
      await expect(verifyOwnedChromium(browser([safeArgs[1]!]), executable, "123.0.0.0")).rejects.toThrow("mute audio");
      await expect(verifyOwnedChromium(browser(safeArgs, "124.0.0.0"), executable, "123.0.0.0")).rejects.toThrow("version mismatch");
      expect(detached).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
