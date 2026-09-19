import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { escapeHtml, renderBenchmarkSnapshot, renderChallenge, renderHarderChallenge, renderPilot, renderProfiles, renderTiers, renderV2 } from "./content.ts";
import { verifyPilot } from "../bench/pilot.ts";
import { verifyCalibration } from "../bench/archive.ts";
import { verifyAdmissionArchive } from "../bench/admission-archive.ts";
import { FAMILIES, SCORER_VERSION, SUITE_VERSION } from "../ladder/mod.ts";

const root = import.meta.dir;

describe("public site contract", () => {
  test("the sample is real and every registered family appears in the ladder", () => {
    expect(renderChallenge()).toContain(">34</code>");
    expect(renderChallenge()).toContain("[1,3,2,5]");
    expect(renderChallenge()).toContain("Algal evaluator");
    const table = renderTiers();
    for (const family of FAMILIES) expect(table).toContain(`<code>${family.name}</code>`);
    expect(table).toContain(SUITE_VERSION);
  });

  test("published calibrations replay and render verified data", () => {
    const v2 = verifyCalibration(resolve(root, "benchmark/v2-calibration-0"));
    const v2Html = renderV2(v2);
    expect(v2Html).toContain("437/499");
    expect(v2Html).toContain("500 instances");
    const profiles = renderProfiles(v2);
    expect(profiles).toContain("Transform fidelity");
    expect(profiles).toContain("98.8%");
    expect(profiles).toContain("79/80");
    expect(v2.suiteHash).toBe("608d81e3473fa321783e5d77a56b8cb0210a6a2493cbb3f85a68eb319b4789df");
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

  test("the compact snapshot uses verified counts and separates the uncalibrated Algal suite", () => {
    const v2 = verifyCalibration(resolve(root, "benchmark/v2-calibration-0"));
    const frontier = verifyCalibration(resolve(root, "benchmark/frontier-v0"));
    const html = renderBenchmarkSnapshot(v2, frontier);
    for (const count of ["437/499", "403/500", "205/500", "140/500", "47/500", "217/340", "186/340", "31/340", "8/340", "0/340"]) expect(html).toContain(count);
    expect(html.match(/<th scope="row">/g)).toHaveLength(5);
    expect(html).toContain("87.6%");
    expect(html).toContain("provider errors excluded");
    expect(html).toContain("new Algal suite, which has no model calibration yet");
    expect(html).toContain('href="/benchmark/"');
    expect(() => renderBenchmarkSnapshot(v2, { ...frontier, models: [] })).toThrow("missing frontier snapshot model");
  });

  test("the harder practice prompt and answer match the immutable published attempt", () => {
    const records = gunzipSync(readFileSync(resolve(root, "benchmark/frontier-v0/openai_gpt-5-mini-020751dc92eb.jsonl.gz"))).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
    const recorded = records.find((record) => record.family === "bitmatrix" && record.tier === 4 && record.seed === 302);
    expect(recorded.expected).toBe("111000");
    const html = renderHarderChallenge();
    expect(html).toContain(escapeHtml(recorded.prompt));
    expect(html).toContain(`<code>${recorded.expected}</code>`);
    expect(html).toContain("Public practice");
    expect(html).toContain("frontier-v0");
    expect(html).toContain("does not issue a receipt");
  });

  test("published admission evidence replays every signature, commitment, score, and verdict", () => {
    expect(verifyAdmissionArchive(resolve(root, "benchmark/admissions-opus5-2026-09-19"))).toEqual({
      id: "opus5-admissions-2026-09-19",
      verifier: { keyId: "da0d70eae14cf7df", publicKey: "MMP-mO0IcwK9gE43NeBPeZ7xsFtol0lXYtiQWZcHFf8" },
      sessions: 4, challenges: 32, passed: 24, admitted: 3,
      tracks: {
        v2: { sessions: 2, challenges: 16, passed: 15, admitted: 2 },
        frontier: { sessions: 2, challenges: 16, passed: 9, admitted: 1 },
      },
    });
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
    // Vercel compiles sources with strict:true; :path* misses root and trailing slashes.
    expect(config.redirects).toContainEqual({ source: "/:path(.*)", has: [{ type: "host", value: "botcaptcha.dev" }], destination: "https://clankdar.com/:path*", permanent: true });
  });

  test("icon bytes match the maintained brand manifest", () => {
    const manifest = readFileSync(resolve(root, "BRAND_ASSETS.md"), "utf8");
    for (const file of ["icon.png", "apple-icon.png"]) {
      const hash = createHash("sha256").update(readFileSync(resolve(root, file))).digest("hex");
      expect(manifest).toContain(hash);
    }
  });
});
