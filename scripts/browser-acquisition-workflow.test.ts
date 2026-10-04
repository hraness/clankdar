import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dir, "..");
const ci = readFileSync(resolve(root, ".github/workflows/check.yml"), "utf8");
const production = readFileSync(resolve(root, ".github/workflows/verify-production.yml"), "utf8");

test("tempfile acquisition regressions participate in Required Bun admission", () => {
  const result = spawnSync("python3", ["-B", "scripts/test_browser_acquisition.py"], { cwd: root, encoding: "utf8" });
  expect(result.stderr).toContain("OK");
  expect(result.status).toBe(0);
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  expect(pkg.scripts.check).toContain("bun test");
  expect(ci).toContain("- run: bun test");
  expect(ci).toContain("needs: [static, unit, browser]");
});

test("both exact pinned browser acquisitions have scoped apt limits and cleanup", () => {
  let count = 0;
  for (const workflow of [ci, production]) {
    expect(workflow).not.toContain("working-directory:");
    for (const step of workflow.split(/^      - /m).slice(1)) {
      if (!step.includes("install --with-deps")) continue;
      count++;
      const command = "bunx --no-install playwright install --with-deps chromium";
      for (const text of [
        "sudo python3 scripts/browser_acquisition.py",
        'config=/etc/apt/apt.conf.d/99-browser-acquisition',
        'sudo test ! -e "$config"', 'sudo test ! -L "$config"',
        'trap \'sudo rm -f "$config"\' EXIT',
        'Acquire::http::Timeout "20";', 'Acquire::https::Timeout "20";',
        'Acquire::Retries "1";', command,
      ]) expect(step).toContain(text);
      expect(step.indexOf("sudo python3")).toBeLessThan(step.indexOf("sudo tee"));
      expect(step.indexOf("trap '")).toBeLessThan(step.indexOf("sudo tee"));
      expect(step.indexOf("sudo tee")).toBeLessThan(step.indexOf(command));
    }
  }
  expect(count).toBe(2);
});

test("routing caches browser versions and existing timeouts remain unchanged", () => {
  expect(ci.match(/timeout-minutes: \d+/g)).toEqual(["timeout-minutes: 10", "timeout-minutes: 10", "timeout-minutes: 10", "timeout-minutes: 5"]);
  expect(production.match(/timeout-minutes: \d+/g)).toEqual(["timeout-minutes: 10"]);
  expect(ci).toContain("key: ${{ runner.os }}-${{ runner.arch }}-playwright-${{ steps.playwright-version.outputs.version }}");
  expect(ci).toContain("path: ~/.cache/ms-playwright");
  expect(ci).toContain("contents: read");
  expect(ci).toContain("branches: [main]");
  expect(ci).toContain("name: Required");
  expect(production).not.toContain("actions/cache@");
  expect(production).toContain("bun run check:browser --production --concurrency 1");
});
