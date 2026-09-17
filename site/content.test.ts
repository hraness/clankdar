import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { escapeHtml, renderChallenge, renderPilot, renderTiers } from "./content.ts";
import { verifyPilot } from "../bench/pilot.ts";
import { FAMILIES, SCORER_VERSION, SUITE_VERSION } from "../ladder/mod.ts";

const root = import.meta.dir;

describe("public site contract", () => {
  test("the sample is real and every registered family appears in the ladder", () => {
    expect(renderChallenge()).toContain("rednoy");
    expect(renderChallenge()).toContain("seed 5");
    const table = renderTiers();
    for (const family of FAMILIES) expect(table).toContain(`<code>${family.name}</code>`);
    expect(table).toContain(SUITE_VERSION);
  });

  test("pilot rendering uses verified data and escapes arbitrary labels", () => {
    const report = verifyPilot(resolve(root, "benchmark/pilot-v0"));
    const html = renderPilot(report);
    expect(html).toContain("161/190");
    expect(html).toContain("Final block");
    expect(html).toContain("190 instances");
    const malicious = structuredClone(report);
    malicious.models[0].model = '<script>alert("no")</script>';
    expect(renderPilot(malicious)).not.toContain("<script>");
    expect(escapeHtml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });

  test("all pages keep canonical branding, static controls, and one shared footer", () => {
    for (const path of ["index.html", "docs/index.html", "benchmark/index.html"]) {
      const html = readFileSync(resolve(root, path), "utf8");
      expect(html.split("<!-- hraness-site-footer -->")).toHaveLength(2);
      expect(html).toContain('class="skip-link"');
      expect(html).toContain('id="main"');
      expect(html).toContain("https://clankdar.com");
      expect(html).not.toContain("clankdar.dev");
      expect(html).not.toContain("botcaptcha.dev");
      expect(html.match(/<script\b/g)).toHaveLength(1);
      expect(html).toContain('<script src="/appearance.js"></script>');
      expect(html).not.toMatch(/<form\b|<iframe\b|\sonclick=/);
    }
    expect(readFileSync(resolve(root, "llms.txt"), "utf8")).toContain(SCORER_VERSION);
  });

  test("headers stay restrictive and legacy URLs redirect without losing paths", () => {
    const config = JSON.parse(readFileSync(resolve(root, "../vercel.json"), "utf8"));
    const headers = Object.fromEntries(config.headers[0].headers.map((header: { key: string; value: string }) => [header.key, header.value]));
    expect(headers["Content-Security-Policy"]).toBe("default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(config.redirects).toContainEqual({ source: "/:path*", has: [{ type: "host", value: "botcaptcha.dev" }], destination: "https://clankdar.com/:path*", permanent: true });
  });

  test("icon bytes match the maintained brand manifest", () => {
    const manifest = readFileSync(resolve(root, "BRAND_ASSETS.md"), "utf8");
    for (const file of ["icon.png", "apple-icon.png"]) {
      const hash = createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex");
      expect(manifest).toContain(hash);
    }
  });
});
