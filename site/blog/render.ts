import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  articleProvenanceFromAdmission,
  assertArticleAdmissions,
  escapeArticleHtml as escape,
  isArticleIndexable,
  renderArticleHtml,
  renderArticleIndexHtml,
  renderArticleRelatedHtml,
  renderArticleSourcesHtml,
  type ArticleTocItem,
} from "@hraness/design-kit";
import { relatedFor } from "@hraness/design-kit/portfolio";
import {
  articleJsonLd,
  blogJsonLd,
  createAtomFeed,
  createBlogSitemapPaths,
  createFeedEntry,
  serializeJsonLd,
  type ArticleDiscovery,
  type SearchSite,
} from "@hraness/web-discovery";
import { ADMISSIONS, BLOG_PATH, POSTS, type BlogPost } from "./articles.ts";

export const SITE: SearchSite = {
  name: "Clankdar",
  title: "Clankdar",
  description: "Clankdar gives AI agents fresh puzzles to solve, scores their answers exactly, and signs a receipt anyone can recheck.",
  origin: "https://clankdar.com",
  language: "en-US",
};
export const FEED_PATH = "/blog/feed.xml";
const BLOG_TITLE = "Clankdar blog";
const BLOG_DESCRIPTION = "Notes from Hraness on how Clankdar checks what AI agents can solve and how to rerun each check.";
const HRANESS = { kind: "Organization", name: "Hraness" } as const;
const IMAGE = { path: "/icon.png", width: 512, height: 512, contentType: "image/png", alt: "The Clankdar mark" } as const;

assertArticleAdmissions(ADMISSIONS);

export function indexablePosts(): readonly BlogPost[] {
  return POSTS.filter(post => isArticleIndexable(post.admission));
}

function timestamp(date: string): string {
  return `${date}T00:00:00.000Z`;
}

export function discovery(post: BlogPost): ArticleDiscovery {
  return {
    type: "BlogPosting",
    canonicalPath: post.path,
    blogPath: BLOG_PATH,
    title: post.title,
    description: post.dek,
    image: IMAGE,
    authors: [HRANESS],
    publisher: HRANESS,
    publishedTime: timestamp(post.published),
    ...(post.updated === undefined ? {} : { modifiedTime: timestamp(post.updated) }),
    keywords: post.tags,
  };
}

/** Markdown body to trusted HTML. The Markdown is repository content, never reader input. */
export function renderBody(post: BlogPost): { html: string; toc: ArticleTocItem[] } {
  const markdown = readFileSync(resolve(import.meta.dir, "posts", `${post.slug}.md`), "utf8");
  const html = Bun.markdown.html(markdown, { headings: { ids: true } })
    .replace(/<table>/g, '<div class="table-scroll" tabindex="0" role="region" aria-label="Table"><table>')
    .replace(/<\/table>/g, "</table></div>");
  // Contents labels come from the Markdown heading text (escaped by the renderer),
  // paired in order with the ids the Markdown renderer assigned.
  const ids = [...html.matchAll(/<h2 id="([^"]+)">/g)].map(match => match[1]!);
  const labels = markdown.replace(/^```[\s\S]*?^```/gm, "").split("\n")
    .filter(line => line.startsWith("## "))
    .map(line => line.slice(3).trim().replaceAll("`", ""));
  if (ids.length !== labels.length) throw new Error(`Contents for ${post.slug} do not match its headings.`);
  const toc = ids.map((id, index) => ({ href: `#${id}` as const, label: labels[index]! }));
  return { html, toc: toc.length >= 4 ? toc.slice(0, 8) : [] };
}

function head(input: { title: string; description: string; path: string; type: "article" | "website"; indexable: boolean; jsonLd: unknown; published?: string }): string {
  const url = `${SITE.origin}${input.path}`;
  return [
    `<title>${escape(input.title)}</title>`,
    `<meta name="description" content="${escape(input.description)}">`,
    input.indexable ? "" : '<meta name="robots" content="noindex, nofollow">',
    `<meta property="og:title" content="${escape(input.title)}">`,
    `<meta property="og:description" content="${escape(input.description)}">`,
    `<meta property="og:image" content="${SITE.origin}${IMAGE.path}">`,
    `<meta property="og:type" content="${input.type}">`,
    `<meta property="og:url" content="${escape(url)}">`,
    `<meta property="og:site_name" content="Clankdar">`,
    input.published === undefined ? "" : `<meta property="article:published_time" content="${input.published}">`,
    '<meta name="twitter:card" content="summary">',
    `<link rel="canonical" href="${escape(url)}">`,
    `<script type="application/ld+json">${serializeJsonLd(input.jsonLd)}</script>`,
  ].filter(Boolean).map(line => `    ${line}`).join("\n");
}

function page(template: string, headHtml: string, main: string, blogIndex: boolean): string {
  return template
    .replace("{{HEAD}}", headHtml)
    .replace("{{BLOG_CURRENT}}", blogIndex ? ' aria-current="page"' : "")
    .replace("{{MAIN}}", main);
}

export function renderPostMain(post: BlogPost): string {
  const { html, toc } = renderBody(post);
  const related = relatedFor("clankdar").map(item => ({ href: item.href, name: item.name, relationship: item.relationship }));
  const after = [
    renderArticleSourcesHtml({ sources: post.sources }),
    renderArticleRelatedHtml({ items: related.slice(0, 3) }),
  ].join("");
  return renderArticleHtml({
    heading: post.title,
    dek: post.dek,
    eyebrow: post.eyebrow,
    author: { kind: "organization", name: "Hraness", href: "https://hraness.com" },
    provenance: articleProvenanceFromAdmission(post.admission),
    published: post.published,
    ...(post.updated === undefined ? {} : { updated: post.updated }),
    toc,
    bodyHtml: html,
    afterHtml: after,
  });
}

export function renderPostPage(template: string, post: BlogPost): string {
  const indexable = isArticleIndexable(post.admission);
  return page(template, head({
    title: `${post.title} · Clankdar`,
    description: post.dek,
    path: post.path,
    type: "article",
    indexable,
    jsonLd: articleJsonLd(SITE, discovery(post)),
    published: timestamp(post.published),
  }), renderPostMain(post), false);
}

export function renderIndexPage(template: string): string {
  const posts = indexablePosts();
  const main = renderArticleIndexHtml({
    heading: "Blog",
    headingId: "title",
    headingLevel: 1,
    id: "posts",
    summary: BLOG_DESCRIPTION,
    items: posts.map(post => ({ href: post.path, title: post.title, dek: post.dek, published: post.published, eyebrow: post.eyebrow, ...(post.updated === undefined ? {} : { updated: post.updated }) })),
  });
  return page(template, head({
    title: "Blog · Clankdar",
    description: BLOG_DESCRIPTION,
    path: BLOG_PATH,
    type: "website",
    indexable: true,
    jsonLd: blogJsonLd(SITE, { name: BLOG_TITLE, description: BLOG_DESCRIPTION, path: BLOG_PATH, publisher: HRANESS }, posts.map(discovery)),
  }), main, true);
}

/** Feed readers resolve relative links unpredictably, so feed bodies use absolute URLs. */
function absoluteLinks(html: string): string {
  return html.replace(/href="\/(?!\/)/g, `href="${SITE.origin}/`);
}

export function renderFeed(): string {
  const posts = indexablePosts();
  return createAtomFeed(SITE, {
    title: BLOG_TITLE,
    description: BLOG_DESCRIPTION,
    homePath: BLOG_PATH,
    path: FEED_PATH,
    authors: [HRANESS],
  }, posts.map(post => createFeedEntry(discovery(post), { contentHtml: absoluteLinks(renderBody(post).html) })));
}

/** The whole sitemap: the static pages plus the blog index and indexable posts with lastmod. */
export function renderSitemap(staticPaths: readonly string[]): string {
  const blog = createBlogSitemapPaths({ path: BLOG_PATH }, indexablePosts().map(discovery));
  const urls = [
    ...staticPaths.map(path => `  <url><loc>${SITE.origin}${path}</loc></url>`),
    ...blog.map(entry => `  <url><loc>${SITE.origin}${entry.path}</loc>${entry.lastModified === undefined ? "" : `<lastmod>${String(entry.lastModified)}</lastmod>`}</url>`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/** The blog section appended to llms.txt: indexable posts only. */
export function renderLlmsSection(): string {
  const lines = indexablePosts().map(post => `- ${post.title}: ${SITE.origin}${post.path}\n  ${post.dek}`);
  return `\n## Blog\n\n${SITE.origin}${BLOG_PATH} (Atom feed: ${SITE.origin}${FEED_PATH})\n\n${lines.join("\n")}\n`;
}
