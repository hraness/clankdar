import { websiteJsonLd } from "@hraness/web-discovery";
import { SITE } from "./blog/render.ts";

// Hraness defines this Organization node on hraness.com; Clankdar references it by @id.
const HRANESS = { "@type": "Organization", "@id": "https://hraness.com/#organization", name: "Hraness", url: "https://hraness.com/" } as const;

/** Distributions listed in the Dataset node. Only reports and manifests carry the CC BY 4.0 grant; the recorded model responses do not. */
export const BENCHMARK_DISTRIBUTIONS = ["benchmark/v2-calibration-0/report.json", "benchmark/v2-calibration-0/manifest.json"] as const;

export function homeJsonLd() {
  const { "@context": _context, ...website } = websiteJsonLd(SITE);
  return {
    "@context": "https://schema.org",
    "@graph": [
      { ...website, publisher: HRANESS },
      {
        "@type": "SoftwareApplication",
        "@id": `${SITE.origin}/#software`,
        name: SITE.name,
        url: `${SITE.origin}/`,
        description: SITE.description,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Any",
        publisher: HRANESS,
        sameAs: ["https://github.com/hraness/clankdar"],
      },
    ],
  };
}

export function benchmarkJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${SITE.origin}/benchmark/#dataset`,
    name: "Clankdar model benchmark reports",
    description: "Five models answered the same 500 generated puzzles on September 17, 2026, under the clankdar-suite-v2 puzzle set and the clankdar-score-v2 scorer. The reports record pass counts, confidence intervals, per-task results, and exclusions.",
    url: `${SITE.origin}/benchmark/`,
    sameAs: "https://huggingface.co/datasets/hranesscom/clankdar-benchmarks",
    license: "https://creativecommons.org/licenses/by/4.0/",
    creator: HRANESS,
    temporalCoverage: "2026-09-17",
    isAccessibleForFree: true,
    distribution: BENCHMARK_DISTRIBUTIONS.map(path => ({ "@type": "DataDownload", contentUrl: `${SITE.origin}/${path}`, encodingFormat: "application/json" })),
  };
}

/** Build-time JSON-LD per page. Source HTML stays script-free apart from its pinned bundles. */
export const PAGE_JSON_LD: Readonly<Record<string, () => unknown>> = {
  "index.html": homeJsonLd,
  "benchmark/index.html": benchmarkJsonLd,
};
