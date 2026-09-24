import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { articleProvenanceFromAdmission, articleProvenanceSentence, assertArticleAdmissions, isArticleIndexable } from "@hraness/design-kit";
import { ADMISSIONS, POSTS } from "./articles.ts";
import { indexablePosts, renderFeed, renderIndexPage, renderLlmsSection, renderPostPage, renderSitemap } from "./render.ts";

const template = readFileSync(resolve(import.meta.dir, "page.html"), "utf8");
const indexable = POSTS.filter(post => isArticleIndexable(post.admission));
const quarantined = POSTS.filter(post => post.admission.lifecycle === "quarantined");

describe("blog", () => {
  test("every post has a valid admission record for its own route", () => {
    expect(() => assertArticleAdmissions(ADMISSIONS)).not.toThrow();
    for (const post of POSTS) {
      expect(post.admission.href).toBe(post.path);
      expect(post.path).toBe(`/blog/${post.slug}`);
      expect(post.admission.humanReview).toBeNull();
    }
    expect(indexable.map(post => post.slug)).toEqual(["introducing-clankdar"]);
    expect(quarantined.map(post => post.slug)).toEqual(["how-clankdar-uses-algal"]);
  });

  test("every post shows the Hraness byline and the recorded AI review", () => {
    for (const post of POSTS) {
      const html = renderPostPage(template, post);
      expect(html).toContain('<span class="plain-publication__byline" data-author-kind="organization">By <a href="https://hraness.com" rel="author">Hraness</a></span>');
      const sentence = articleProvenanceSentence(articleProvenanceFromAdmission(post.admission));
      expect(sentence).toBe("Drafted with AI from the source code and reviewed by Claude Opus 5.5 (claude-opus-5-5) editorial review.");
      expect(html).toContain(sentence);
      expect(html).not.toMatch(/human/i);
      expect(html).toContain(`<link rel="canonical" href="https://clankdar.com${post.path}">`);
      expect(html).toContain('"@type":"BlogPosting"');
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
      expect(sitemap).toContain(`<loc>https://clankdar.com${post.path}</loc><lastmod>${post.published}T00:00:00.000Z</lastmod>`);
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

  test("post links go to manifest posts, live pages, or absolute cross-host URLs", () => {
    const allowed = new Set(["/#try", "/benchmark/", "/docs/#security", ...POSTS.map(post => post.path)]);
    for (const post of POSTS) {
      const markdown = readFileSync(resolve(import.meta.dir, "posts", `${post.slug}.md`), "utf8");
      for (const [, href] of markdown.matchAll(/\]\(([^)]+)\)/g)) {
        if (href!.startsWith("/")) expect(allowed.has(href!)).toBe(true);
        else expect(href).toMatch(/^https:\/\//);
      }
      expect(markdown).not.toContain("—");
    }
  });
});
