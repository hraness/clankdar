/**
 * Pins the launch facts, not the prose: every number in the beats resolves
 * from the code, and every mockup value comes from a run the repository's
 * own verifier accepts (or, for the tampered file, rejects).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HOSTED_POLICIES } from "../../cloudflare/src/challenges.ts";
import { algalWorkedExample } from "../../ladder/families/algal.ts";
import { FAMILIES } from "../../ladder/mod.ts";
import { verifyReceipt } from "../../cloudflare/examples/verify-receipt.mjs";
import { LAUNCH_BEATS, LAUNCH_SOCIAL_KIT } from "./beats.ts";
import { LAUNCH_FACTS, LAUNCH_RELEASE } from "./facts.ts";
import { DEMO_RUN, DEMO_VERIFICATION, FAIL_RUN, FAIL_VERIFICATION, TAMPER } from "./fixtures.ts";
import { renderLaunchBodyHtml } from "./post.tsx";
import { renderSocialKitMarkdown } from "./social-kit-markdown.ts";
import { SOCIAL_KIT_PATH } from "./write-social-kit.ts";

const fixture = (name: string) => readFileSync(resolve(import.meta.dir, "fixtures", name));

describe("launch facts", () => {
  test("come from the hosted policy, the worked example and the family list", () => {
    const policy = HOSTED_POLICIES["algal-floor-v1"]!;
    expect(LAUNCH_FACTS.policyPuzzles.value).toBe(String(policy.challenges));
    expect(LAUNCH_FACTS.policyPasses.value).toBe(String(policy.minPass));
    expect(LAUNCH_FACTS.policySeconds.value).toBe(String(policy.ttlSeconds));
    expect(LAUNCH_FACTS.exampleAnswer.value).toBe(String(algalWorkedExample().answer));
    expect(LAUNCH_FACTS.familyCount.value).toBe(String(FAMILIES.length));
  });

  test("keep the staging limits STYLE.md requires", () => {
    expect([LAUNCH_FACTS.policyPuzzles.value, LAUNCH_FACTS.policyPasses.value, LAUNCH_FACTS.policySeconds.value]).toEqual(["4", "3", "180"]);
    expect([LAUNCH_FACTS.stagingTotal.value, LAUNCH_FACTS.stagingPerMinute.value]).toEqual(["1,024", "60"]);
  });

  test("the Bun version matches packageManager", () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8")) as { packageManager: string };
    expect(pkg.packageManager).toBe(`bun@${LAUNCH_FACTS.bunVersion.value}`);
  });

  test("the status is Preview and nothing asks readers to install", () => {
    expect(LAUNCH_RELEASE.status).toBe("Preview");
    const readme = readFileSync(resolve(import.meta.dir, "../../README.md"), "utf8");
    expect(readme).toContain("Preview");
    expect(LAUNCH_BEATS.at(-1)!.post).toContain("Clankdar is in Preview.");
  });
});

describe("recorded runs behind the mockups", () => {
  test("the passing demo receipt verifies with the repository verifier", () => {
    const result = verifyReceipt(fixture("demo-receipt.json"), { issuerPublicKey: DEMO_VERIFICATION.issuerPublicKey, sha256: DEMO_VERIFICATION.sha256 });
    expect(result).toMatchObject({ ok: true, pass: true, passed: 4, required: 3 });
    expect(DEMO_RUN.puzzles.every(puzzle => puzzle.pass && puzzle.expected === puzzle.response)).toBe(true);
  });

  test("the failing custom-solver receipt verifies and reports a fail", () => {
    const result = verifyReceipt(fixture("fail-receipt.json"), { issuerPublicKey: FAIL_VERIFICATION.issuerPublicKey, sha256: FAIL_VERIFICATION.sha256 });
    expect(result).toMatchObject({ ok: true, pass: false, passed: 0 });
    expect(FAIL_RUN.puzzles.every(puzzle => puzzle.response === "33" && !puzzle.pass)).toBe(true);
  });

  test("the tampered receipt differs by one answer and is rejected", () => {
    expect(DEMO_RUN.puzzles.some(puzzle => puzzle.expected === TAMPER.from)).toBe(true);
    const original = fixture("demo-receipt.json").toString("utf8");
    const tampered = fixture("tampered-receipt.json").toString("utf8");
    expect(tampered).not.toBe(original);
    const result = verifyReceipt(Buffer.from(tampered), { issuerPublicKey: DEMO_VERIFICATION.issuerPublicKey });
    expect(JSON.stringify(result)).toBe(TAMPER.verifierOutput);
  });
});

describe("launch post", () => {
  test("every beat has a visual and every social post fits its channel", () => {
    expect(LAUNCH_BEATS.length).toBeGreaterThanOrEqual(6);
    for (const [channel, limit] of [["x", 280], ["bluesky", 300], ["threads", 500]] as const) {
      expect(LAUNCH_SOCIAL_KIT[channel]).toHaveLength(LAUNCH_BEATS.filter(beat => beat.part !== "limits").length);
      for (const post of LAUNCH_SOCIAL_KIT[channel]) expect(post.length).toBeLessThanOrEqual(limit);
    }
    expect(LAUNCH_SOCIAL_KIT.productHunt.tagline).toBe("Check what your agent can solve.");
  });

  test("the body renders every beat and never embeds a film that is not delivered", () => {
    const html = renderLaunchBodyHtml();
    for (const beat of LAUNCH_BEATS) expect(html).toContain(`id="beat-${beat.id}"`);
    expect(html).not.toMatch(/\{[a-z][A-Za-z]+\}/u);
    if (!["clankdar-launch.mp4", "clankdar-launch-poster.jpg", "clankdar-launch.vtt"].every(name => Bun.file(resolve(import.meta.dir, "../media", name)).size > 0)) expect(html).not.toContain("<video");
  });

  test("docs/launch/social-kit.md is current (run bun run launch:kit)", () => {
    expect(readFileSync(SOCIAL_KIT_PATH, "utf8")).toBe(renderSocialKitMarkdown());
  });
});
