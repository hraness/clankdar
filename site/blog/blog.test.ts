import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { articleProvenanceFromAdmission, articleProvenanceSentence, assertArticleAdmissions, isArticleIndexable } from "@hraness/design-kit";
import { ADMISSIONS, POSTS } from "./articles.ts";
import { articleRelatedProducts, portfolioMarkAssets } from "../portfolio-marks";
import { relatedFor } from "../portfolio-copy";
import { indexablePosts, renderBody, renderFeed, renderIndexPage, renderLlmsSection, renderPostPage, renderSitemap } from "./render.ts";

const template = readFileSync(resolve(import.meta.dir, "page.html"), "utf8");
const indexable = POSTS.filter(post => isArticleIndexable(post.admission));
const quarantined = POSTS.filter(post => post.admission.lifecycle === "quarantined");

describe("blog", () => {
  test("related product icons use the exact registry artwork from the same origin", () => {
    const registryProducts = relatedFor("clankdar").slice(0, 3);
    expect(registryProducts.length).toBeGreaterThan(0);
    for (const [index, product] of registryProducts.entries()) {
      const asset = portfolioMarkAssets[index]!;
      expect(asset.svg).toBe(decodeURIComponent(product.mark.slice("data:image/svg+xml,".length)));
      expect(articleRelatedProducts[index]!.mark).toBe(asset.href);
      expect(asset.href).toMatch(/^\/marks\/portfolio\/[a-f0-9]{64}\.svg$/);
      for (const post of POSTS) {
        const html = renderPostPage(template, post);
        expect(html).toContain(`src="${asset.href}"`);
        expect(html).toContain('class="plain-publication__related-mark"');
        expect(html).not.toContain('src="data:image/svg+xml,');
      }
    }
  });

  test("every post has a valid admission record for its own route", () => {
    expect(() => assertArticleAdmissions(ADMISSIONS)).not.toThrow();
    for (const post of POSTS) {
      expect(post.admission.href).toBe(post.path);
      expect(post.path).toBe(`/blog/${post.slug}`);
      // A recorded human review names a person and never an AI reviewer.
      if (post.admission.humanReview !== null) expect(post.admission.humanReview.reviewerType).not.toBe("ai");
    }
    const aiReview = { reviewer: "Codex", reviewerType: "ai", reviewedOn: "2026-10-01" } as const;
    expect(() => assertArticleAdmissions([{ ...ADMISSIONS[0]!, review: { ...aiReview, reviewer: "Codex human review" } }])).toThrow();
    expect(() => assertArticleAdmissions([{ ...ADMISSIONS[0]!, review: aiReview, humanReview: aiReview }])).toThrow();
    expect(indexable.map(post => post.slug)).toEqual(["introducing-clankdar", "how-clankdar-uses-algal", "held-out-puzzles", "what-a-receipt-proves"]);
    expect(quarantined.map(post => post.slug)).toEqual([]);
  });

  test("every post shows the Hraness byline and the review on record, naming only a human editor as human", () => {
    for (const post of POSTS) {
      const html = renderPostPage(template, post);
      expect(html).toContain('<span class="plain-publication__byline" data-author-kind="organization">By <a href="https://hraness.com" rel="author">Hraness</a></span>');
      const sentence = articleProvenanceSentence(articleProvenanceFromAdmission(post.admission));
      const review = post.admission.review!;
      expect(["ai", "human-editor"]).toContain(review.reviewerType);
      expect(html).toContain(sentence);
      if (review.reviewerType === "human-editor") {
        expect(sentence).toBe(`Drafted with AI from the source code and reviewed by ${review.reviewer}, a human editor.`);
      } else {
        expect(sentence).toBe(`Drafted with AI from the source code and reviewed by ${review.reviewer}.`);
        // The reviewer-name ban targets the provenance note, not ordinary body prose that may mention a human.
        expect(sentence).not.toMatch(/human/i);
      }
      expect(html).toContain(`<link rel="canonical" href="https://clankdar.com${post.path}">`);
      expect(html).toContain('"@type":"BlogPosting"');
      // The launch post reads as a thread of standalone beats, so only Markdown posts carry a contents list.
      if (post.launch) expect(html).not.toContain('class="plain-publication__toc"');
      else expect(html).toContain('<nav aria-labelledby="article-title-contents" class="plain-publication__toc">');
      expect(html.split("<!-- hraness-site-footer -->")).toHaveLength(2);
      expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
      expect(html).not.toContain("botcaptcha.dev");
      expect(html).not.toMatch(/<form\b|<iframe\b|\sonclick=|\sstyle=/);
    }
  });

  test("quarantined posts are noindex and absent from every discovery list", () => {
    const index = renderIndexPage(template);
    const feed = renderFeed();
    const sitemap = renderSitemap(["/"]);
    const llms = renderLlmsSection();
    expect(index).not.toContain('name="robots"');
    for (const post of indexable) {
      expect(renderPostPage(template, post)).not.toContain('name="robots"');
      for (const surface of [index, feed, sitemap, llms]) expect(surface).toContain(post.path);
      expect(sitemap).toContain(`<loc>https://clankdar.com${post.path}</loc><lastmod>${post.updated ?? post.published}T00:00:00.000Z</lastmod>`);
    }
    for (const post of quarantined) {
      expect(renderPostPage(template, post)).toContain('<meta name="robots" content="noindex, nofollow">');
      // An indexable body may still link to a readable quarantined post; only listings are checked.
      expect(index).not.toContain(`href="${post.path}"`);
      expect(feed).not.toContain(`<id>https://clankdar.com${post.path}</id>`);
      expect(sitemap).not.toContain(post.path);
      expect(llms).not.toContain(post.path);
    }
    expect(indexablePosts()).toEqual(indexable);
  });

  test("the sitemap keeps the static pages and the blog index", () => {
    const sitemap = renderSitemap(["/", "/docs/", "/benchmark/"]);
    for (const path of ["/", "/docs/", "/benchmark/", "/blog/"]) expect(sitemap).toContain(`<loc>https://clankdar.com${path}</loc>`);
  });

  test("docs anchors the posts link to exist", () => {
    const docs = readFileSync(resolve(import.meta.dir, "..", "docs", "index.html"), "utf8");
    for (const id of ["security", "verification", "own-solver", "integrate"]) expect(docs).toContain(`id="${id}"`);
  });

  test("post links go to manifest posts, live pages, or absolute cross-host URLs", () => {
    const allowed = new Set(["/#try", "/benchmark/", "/docs/#security", "/docs/#verification", "/docs/#own-solver", "/docs/#integrate", ...POSTS.map(post => post.path)]);
    for (const post of POSTS) {
      const body = post.launch ? renderBody(post).html : readFileSync(resolve(import.meta.dir, "posts", `${post.slug}.md`), "utf8");
      const hrefs = post.launch ? [...body.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)] : [...body.matchAll(/\]\(([^)]+)\)/g)];
      if (post.launch) expect(hrefs.length).toBeGreaterThan(0);
      for (const [, href] of hrefs) {
        if (href!.startsWith("#")) continue;
        if (href!.startsWith("/")) expect(allowed.has(href!)).toBe(true);
        else expect(href).toMatch(/^https:\/\//);
      }
      expect(body).not.toContain("—");
    }
  });
});
