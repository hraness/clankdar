import { describe, expect, test } from "bun:test";
import { plural, renderActorProfile, renderCampaignProfile } from "./src/public.ts";

describe("public evidence pages", () => {
  test("keeps absent evidence absent and uses same-origin assets with a restrictive CSP", async () => {
    const response = renderActorProfile({ address: "clank1_test", publicKey: "public", evidence: { campaigns: 0 }, claims: {} });
    const html = await response.text();
    expect(html).toContain("No scheduled responses yet");
    expect(html).toContain("No capability results yet");
    expect(html).toContain("No campaigns yet");
    expect(html).toContain('id="hraness-site-footer"');
    expect(html).toContain('data-palette="tokyo-night"');
    expect(html).toContain('href="/design/palette-bridge.css"');
    expect(html).toContain('media="(prefers-color-scheme: light)" content="#e1e2e7"');
    expect(html).toContain('media="(prefers-color-scheme: dark)" content="#1a1b26"');
    expect(html).not.toContain('data-theme="light"');
    expect(html).not.toContain("0% uptime");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'none'");
    expect([...html.matchAll(/(?:src|href)="(https?:[^\"]+)"/g)].every(m => !m[0].startsWith("src=") && m[1].startsWith("https://"))).toBe(true);
  });

  test("untrusted labels never become markup or executable evidence URLs", async () => {
    const html = await renderCampaignProfile({
      campaignId: 'cmp_<script>alert(1)</script>', policyId: '<img src=x onerror="alert(1)">',
      epochs: 3, evidence: { scheduled: 3, completed: 1, missed: 1, admitted: 0 },
      scheduleCommit: '<svg onload="alert(1)">',
    }, 'clank1_" onclick="evil', [{ epoch: 0, status: "decided", evidenceHash: 'javascript:alert(1)' }]).text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("1 responded · 1 missed");
    expect(html).toContain("1 check remains");
    expect(html).toContain("0 of 1 response passed");
    expect(html).toContain("&lt;svg");
  });

  test("public history links only content-addressed evidence and independent result dimensions", async () => {
    const hash = "a".repeat(64);
    const html = await renderCampaignProfile({ campaignId: "cmp_test", policyId: "v2-floor-v1", epochs: 2, evidence: { scheduled: 2, completed: 1, missed: 1, admitted: 0 }, completedAt: "2026-09-19T12:00:00Z" }, "clank1_test", [{ epoch: 0, status: "decided", evidenceHash: hash, verdict: 0 }, { epoch: 1, status: "missed" }]).text();
    expect(html).toContain(`/v1/evidence/${hash}`);
    expect(html).toContain("Did not pass");
    expect(html).toContain("Missed");
    expect(html).toContain("A completed campaign.");
  });

  test("interpolated counts agree with their nouns for zero, one, and several", async () => {
    expect([0, 1, 2].map((n) => plural(n, "check", "checks"))).toEqual(["0 checks", "1 check", "2 checks"]);
    const campaign = async (scheduled: number, completed: number, pendingEvidence: number) => renderCampaignProfile({
      campaignId: "cmp_test", policyId: "algal-floor-v1", epochs: scheduled, cadenceSeconds: 3600, windowSeconds: 120,
      evidence: { scheduled, completed, missed: 0, admitted: 0, challengesPassed: completed, pendingEvidence },
    }, "clank1_test").text();
    for (const [scheduled, completed, pending, remains, passed, recorded] of [
      [1, 1, 0, "0 checks remain or have", "0 of 1 response passed", "1 individual puzzle passed"],
      [2, 1, 1, "1 check remains or has", "0 of 1 response passed", "1 recorded result is waiting"],
      [5, 2, 3, "3 checks remain or have", "0 of 2 responses passed", "3 recorded results are waiting"],
    ] as const) {
      const html = await campaign(scheduled, completed, pending);
      expect(html).toContain(remains);
      expect(html).toContain(passed);
      expect(html).toContain(recorded);
      expect(html).not.toMatch(/\b1 (checks|responses|results|puzzles|heartbeats|campaigns)\b/);
    }
    const actor = async (campaigns: number, heartbeats: number) => (await renderActorProfile({ address: "clank1_test", publicKey: "public", evidence: { campaigns, heartbeats }, claims: {} })).text();
    expect(await actor(0, 0)).toContain("0 committed campaigns. 0 heartbeats.");
    expect(await actor(1, 1)).toContain("1 committed campaign. 1 heartbeat.");
    expect(await actor(2, 3)).toContain("2 committed campaigns. 3 heartbeats.");
  });
});
