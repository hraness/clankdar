import { marketing } from "./portfolio-copy";
// The one declaration every Clankdar share image comes from. The card design
// lives in @hraness/web-discovery; pages pass copy only.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import {
  createSocialImageCard,
  defineSocialImageSite,
  socialImageAlt,
  socialImageSiteDetails,
  type SocialImagePage,
} from "@hraness/web-discovery/social-image/card";

const mark = readFileSync(resolve(import.meta.dir, "marks/clankdar.svg"));

export const socialSite = defineSocialImageSite({
  name: marketing.names.name,
  // The shared card uses a full sentence; its wording is canonical marketing copy.
  description: `${marketing.short.replace(/[.!?]$/, "")}.`,
  domain: "clankdar.com",
  // The header shows the radar-dish mark in foil beside the canonical name.
  brand: marketing.names.name,
  brandMark: `data:image/svg+xml;base64,${mark.toString("base64")}`,
  // The site's html data-palette; the card takes its light-theme header and hero colours.
  palette: "tokyo-night",
});

export const homeSocialPage = {
  layout: "product",
  eyebrow: marketing.category.toUpperCase(),
  headline: marketing.hero.heading,
  description: marketing.hero.summary,
} as const satisfies SocialImagePage;

export const SOCIAL_IMAGE_WIDTH = 1200;
export const SOCIAL_IMAGE_HEIGHT = 630;
export const SOCIAL_IMAGE_TYPE = "image/png";

export type SocialImage = Readonly<{ path: `/${string}`; width: number; height: number; contentType: typeof SOCIAL_IMAGE_TYPE; alt: string }>;

/** Where a card is served and what it says. */
export function socialImage(path: `/${string}`, page?: SocialImagePage): SocialImage {
  if (!/^\/og(\/[a-z0-9-]+)*\.png$/.test(path)) throw new Error(`Social image path must be /og.png or /og/…/<name>.png: ${path}`);
  return { path, width: SOCIAL_IMAGE_WIDTH, height: SOCIAL_IMAGE_HEIGHT, contentType: SOCIAL_IMAGE_TYPE, alt: socialImageAlt(socialSite, page) };
}

export function socialImageMeta(image: SocialImage, origin = "https://clankdar.com"): string[] {
  const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return [
    `<meta property="og:image" content="${origin}${image.path}">`,
    `<meta property="og:image:type" content="${image.contentType}">`,
    `<meta property="og:image:width" content="${image.width}">`,
    `<meta property="og:image:height" content="${image.height}">`,
    `<meta property="og:image:alt" content="${escape(image.alt)}">`,
  ];
}

/**
 * Rasterizes the shared template for this site with satori and resvg. Strict:
 * the build fails when copy would be shortened, resized, or stripped.
 */
export async function renderSocialImage(page?: SocialImagePage): Promise<Uint8Array> {
  const card = createSocialImageCard({ ...socialImageSiteDetails(socialSite, page), strict: true });
  const svg = await satori(card.element, {
    fonts: card.fonts.map(font => ({ data: font.data, name: font.name, style: font.style, weight: font.weight })),
    height: card.height,
    width: card.width,
  });
  return new Resvg(svg).render().asPng();
}

/** Each static page's card and the copy it passes, short enough for two lines on the card. */
export const PAGE_SOCIAL_IMAGES: Readonly<Record<string, Readonly<{ path: `/${string}`; page?: SocialImagePage }>>> = {
  "index.html": { path: "/og.png", page: homeSocialPage },
  "docs/index.html": {
    path: "/og/docs.png",
    page: {
      eyebrow: "Documentation",
      headline: "Your first check",
      description: "Run a check without credentials, then call the hosted API and verify each receipt offline.",
    },
  },
  "benchmark/index.html": {
    path: "/og/benchmark.png",
    page: {
      eyebrow: "Benchmark",
      headline: "Model benchmark",
      description: "Five models, the same 500 puzzles, and how often each was exactly right.",
    },
  },
};
