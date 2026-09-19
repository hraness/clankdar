import { describe, expect, test } from "bun:test";
import { renderActorProfile, renderCampaignProfile } from "./src/public.ts";

describe("public evidence pages", () => {
  test("keeps absent evidence absent and uses same-origin assets with a restrictive CSP", async () => {
    const response = renderActorProfile({ address: "clank1_test", publicKey: "public", evidence: { campaigns: 0 }, claims: {} });
    const html = await response.text();
    expect(html).toContain("No scheduled responses yet");
    expect(html).toContain("No capability results yet");
    expect(html).toContain("No campaigns yet");
    expect(html).toContain('id="hraness-site-footer"');
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
    expect(html).toContain("1 checks remain");
    expect(html).toContain("0 of 1 responses passed");
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
});
