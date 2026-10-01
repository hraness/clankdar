import { createHash } from "node:crypto";
import { portfolioProvenance } from "@hraness/design-kit/portfolio";
import packageJson from "../package.json";
import { relatedFor } from "./portfolio-copy";

const products = relatedFor("clankdar").slice(0, 3);
const prefix = "data:image/svg+xml,";

// Serve the pinned registry artwork verbatim from our own origin so it works
// with img-src 'self'. The build regenerates these assets; no artwork is forked.
export const portfolioMarkAssets = products.map((item) => {
  if (!item.mark.startsWith(prefix)) throw new Error(`Expected portfolio SVG mark: ${item.productId}`);
  const svg = decodeURIComponent(item.mark.slice(prefix.length));
  const sha256 = createHash("sha256").update(svg).digest("hex");
  return { productId: item.productId, href: `/marks/portfolio/${sha256}.svg`, sha256, svg };
});

export const articleRelatedProducts = products.map((item, index) => ({ ...item, mark: portfolioMarkAssets[index]!.href }));

export const portfolioMarkManifest = {
  designKit: packageJson.dependencies["@hraness/design-kit"],
  registry: portfolioProvenance.registry,
  registryCommit: portfolioProvenance.commit,
  registryDigest: portfolioProvenance.upstreamDigest,
  assets: portfolioMarkAssets.map(({ svg: _svg, ...asset }) => asset),
};
