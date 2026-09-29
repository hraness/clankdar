import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { product } from "@hraness/design-kit/portfolio";
import { socialImageAlt, socialImageSiteDetails } from "@hraness/web-discovery/social-image/card";
import { POSTS } from "./blog/articles.ts";
import { BLOG_SOCIAL_CARD, postSocialCard, renderIndexPage, renderPostPage } from "./blog/render.ts";
import { PAGE_SOCIAL_IMAGES, SOCIAL_IMAGE_HEIGHT, SOCIAL_IMAGE_WIDTH, renderSocialImage, socialImage, socialSite } from "./social.ts";

const root = import.meta.dir;
const template = readFileSync(resolve(root, "blog/page.html"), "utf8");

describe("share images", () => {
  test("one site declaration carries the registry name, one-liner, domain, mark, and light theme", () => {
    const details = socialImageSiteDetails(socialSite);
    expect(details.title).toBe(product("clankdar").name);
    expect(details.description).toBe(product("clankdar").oneLiner);
    expect(details.domain).toBe("clankdar.com");
    const mark = readFileSync(resolve(root, "marks/clankdar.svg")).toString("base64");
    expect(socialSite.icon).toEqual({ kind: "mark", src: `data:image/svg+xml;base64,${mark}` });
    expect(Object.keys(socialSite.theme ?? {}).sort()).toEqual(["accent", "background", "foreground", "muted"]);
    for (const colour of Object.values(socialSite.theme ?? {})) expect(colour).toMatch(/^#[0-9A-F]{6}$/);
  });

  test("every static page has one image slot and a card that passes page copy only", () => {
    for (const [page, card] of Object.entries(PAGE_SOCIAL_IMAGES)) {
      const html = readFileSync(resolve(root, page), "utf8");
      expect(html.split("{{SOCIAL_IMAGE}}")).toHaveLength(2);
      expect(html).not.toContain('property="og:image"');
      if (card.page !== undefined) expect(Object.keys(card.page).sort()).toEqual(["description", "eyebrow", "headline"]);
    }
    expect(PAGE_SOCIAL_IMAGES["index.html"]).toEqual({ path: "/og.png" });
  });

  test("blog pages point at their own card with the template's alt text", () => {
    const index = renderIndexPage(template);
    expect(index).toContain('<meta property="og:image" content="https://clankdar.com/og/blog.png">');
    expect(index).toContain(`content="${socialImageAlt(socialSite, BLOG_SOCIAL_CARD.page)}"`);
    for (const post of POSTS) {
      const card = postSocialCard(post);
      expect(card.page).toEqual({ eyebrow: post.eyebrow, headline: post.title, description: post.cardDek });
      expect(post.cardDek.length).toBeLessThanOrEqual(96);
      const html = renderPostPage(template, post);
      expect(html).toContain(`<meta property="og:image" content="https://clankdar.com/og/blog/${post.slug}.png">`);
      expect(html).toContain('<meta property="og:image:width" content="1200">');
      expect(html).toContain('<meta property="og:image:type" content="image/png">');
      expect(html).toContain(`"contentUrl":"https://clankdar.com/og/blog/${post.slug}.png"`);
    }
  });

  test("the rendered card is a 1200x630 PNG", async () => {
    expect(socialImage("/og.png")).toMatchObject({ width: SOCIAL_IMAGE_WIDTH, height: SOCIAL_IMAGE_HEIGHT, contentType: "image/png" });
    const bytes = Buffer.from(await renderSocialImage());
    expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
  }, 30_000);
});
