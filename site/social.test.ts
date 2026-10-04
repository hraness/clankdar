import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { marketing } from "./portfolio-copy";
import { socialImageAlt, socialImageFit, socialImageSiteDetails, socialImageTypography } from "@hraness/web-discovery/social-image/card";
import { POSTS } from "./blog/articles.ts";
import { BLOG_SOCIAL_CARD, postSocialCard, renderIndexPage, renderPostPage } from "./blog/render.ts";
import { homeSocialPage, PAGE_SOCIAL_IMAGES, SOCIAL_IMAGE_HEIGHT, SOCIAL_IMAGE_WIDTH, renderSocialImage, socialImage, socialSite } from "./social.ts";

const root = import.meta.dir;
const template = readFileSync(resolve(root, "blog/page.html"), "utf8");

describe("share images", () => {
  test("one site declaration carries the registry name, one-liner, domain, header mark, and palette", () => {
    const details = socialImageSiteDetails(socialSite);
    expect(details.title).toBe(marketing.names.name);
    expect(details.description).toBe(`${marketing.short.replace(/[.!?]$/, "")}.`);
    expect(details.domain).toBe("clankdar.com");
    const mark = readFileSync(resolve(root, "marks/clankdar.svg")).toString("base64");
    // The card repeats the header: the foil radar-dish mark, the canonical name, and the tokyo-night palette.
    expect(socialSite.brandMark).toBe(`data:image/svg+xml;base64,${mark}`);
    expect(socialSite.brand).toBe(marketing.names.name);
    expect(socialSite.palette).toBe("tokyo-night");
    expect(readFileSync(resolve(root, "index.html"), "utf8")).toContain('data-palette="tokyo-night"');
    expect(socialSite.icon).toBeUndefined();
    expect(socialSite.theme).toBeUndefined();
  });

  test("every static page has one image slot and a card that passes page copy only", () => {
    for (const [page, card] of Object.entries(PAGE_SOCIAL_IMAGES)) {
      const html = readFileSync(resolve(root, page), "utf8");
      expect(html.split("{{SOCIAL_IMAGE}}")).toHaveLength(2);
      expect(html).not.toContain('property="og:image"');
      if (card.page !== undefined) expect(Object.keys(card.page).sort()).toEqual(page === "index.html" ? ["description", "eyebrow", "headline", "layout"] : ["description", "eyebrow", "headline"]);
    }
    expect(PAGE_SOCIAL_IMAGES["index.html"]).toEqual({ path: "/og.png", page: homeSocialPage });
    expect(homeSocialPage).toEqual({ layout: "product", eyebrow: marketing.category.toUpperCase(), headline: marketing.hero.heading, description: marketing.hero.summary });
  });

  test("blog pages point at their own card with the template's alt text", () => {
    const index = renderIndexPage(template);
    expect(index).toContain('<meta property="og:image" content="https://clankdar.com/og/blog.png">');
    expect(index).toContain(`content="${socialImageAlt(socialSite, BLOG_SOCIAL_CARD.page)}"`);
    for (const post of POSTS) {
      const card = postSocialCard(post);
      expect(card.page).toEqual({ eyebrow: post.cardEyebrow ?? post.eyebrow, headline: post.cardTitle ?? post.title, description: post.cardDek });
      if (post.cardTitle !== undefined) expect(post.title.startsWith(post.cardTitle)).toBe(true);
      expect(post.cardDek.length).toBeLessThanOrEqual(96);
      const html = renderPostPage(template, post);
      expect(html).toContain(`<meta property="og:image" content="https://clankdar.com/og/blog/${post.slug}.png">`);
      expect(html).toContain('<meta property="og:image:width" content="1200">');
      expect(html).toContain('<meta property="og:image:type" content="image/png">');
      expect(html).toContain(`"contentUrl":"https://clankdar.com/og/blog/${post.slug}.png"`);
    }
  });

  test("every declared card fits as written in the shared template", () => {
    const cards = [...Object.values(PAGE_SOCIAL_IMAGES), BLOG_SOCIAL_CARD, ...POSTS.map(postSocialCard)];
    for (const card of cards) {
      const fit = socialImageFit(socialImageSiteDetails(socialSite, card.page));
      expect({ path: card.path, issues: fit.issues }).toEqual({ path: card.path, issues: [] });
      // Findings include the review codes strict mode ignores (reduced, repeated or ellipsized copy, missing eyebrows).
      expect({ path: card.path, findings: fit.findings }).toEqual({ path: card.path, findings: [] });
      expect(fit.removed).toEqual([]);
      expect(fit.headline.lines.length).toBeLessThanOrEqual(2);
      // A page card shows its own copy, never the home tagline, and its eyebrow survives de-duplication.
      if (card.page !== undefined) {
        expect(fit.layout).toBe(card.page.layout ?? "page");
        expect(fit.description?.lines.join(" ")).toBe(socialImageTypography(card.page.description ?? ""));
        expect(card.page.description).not.toBe(socialSite.description);
        expect(typeof card.page.eyebrow).toBe("string");
        expect(fit.eyebrow).toBe(card.page.eyebrow as string);
      }
    }
  });

  test("the rendered card is a 1200x630 PNG", async () => {
    expect(socialImage("/og.png")).toMatchObject({ width: SOCIAL_IMAGE_WIDTH, height: SOCIAL_IMAGE_HEIGHT, contentType: "image/png" });
    const bytes = Buffer.from(await renderSocialImage(homeSocialPage));
    expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
  }, 30_000);
});
