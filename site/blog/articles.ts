import type { ArticleAdmission, ArticleIsoDate, ArticleSourceItem } from "@hraness/design-kit";

/**
 * Clankdar's blog registry. Each post's body lives in `posts/<slug>.md` (the
 * launch post's body is the beats in site/launch); this
 * file holds its page metadata and its editorial admission record, which
 * decides whether the post may be indexed, listed, and syndicated.
 */
export type BlogPost = Readonly<{
  slug: string;
  /** The canonical path, without a trailing slash. */
  path: `/blog/${string}`;
  title: string;
  dek: string;
  /** The dek shortened to fit two lines on the share image. */
  cardDek: string;
  eyebrow: string;
  /** The share image's eyebrow when the page eyebrow would repeat the title. */
  cardEyebrow?: string;
  /** The title shortened to fit two lines at the share image's standard size. */
  cardTitle?: string;
  published: ArticleIsoDate;
  updated?: ArticleIsoDate;
  tags: readonly string[];
  sources: readonly ArticleSourceItem[];
  admission: ArticleAdmission;
  /** True for the launch post, whose body is the beats in site/launch rather than a Markdown file. */
  launch?: true;
}>;

export const BLOG_PATH = "/blog/";

/** The date the cited sources were last checked against the repository. */
const SOURCES_CHECKED_ON: ArticleIsoDate = "2026-10-01";
/** Independent source and editorial review of the complete revised bodies. */
const REVIEW = {
  reviewer: "Codex",
  reviewerType: "ai",
  reviewedOn: "2026-10-01",
} as const;
const LAUNCH_REVIEW = REVIEW;

function repo(repository: "clankdar" | "algal", file: string): string {
  return `https://github.com/hraness/${repository}/blob/main/${file}`;
}

function source(title: string, repository: "clankdar" | "algal", file: string, checkedOn: ArticleIsoDate = SOURCES_CHECKED_ON): ArticleSourceItem {
  return { title, href: repo(repository, file), publisher: "GitHub", checkedOn };
}

function admissionSources(sources: readonly ArticleSourceItem[]) {
  return sources.map(item => ({ title: item.title, url: item.href, checkedOn: item.checkedOn }));
}

const introducingSources = [
  source("Default policy and worked puzzle", "clankdar", "site/launch/facts.ts"),
  source("Passing, failing, and edited example results", "clankdar", "site/launch/fixtures.ts"),
  source("Offline receipt verification", "clankdar", "cloudflare/examples/verify-receipt.mjs"),
  source("Local setup and hosted access", "clankdar", "README.md"),
  source("ALGAL puzzle suite", "clankdar", "docs/clankdar-algal-v1.md"),
] as const;

const usesSources = [
  source("Default puzzle generator and worked example", "clankdar", "ladder/families/algal.ts"),
  source("Evaluator version and work budget", "clankdar", "ladder/algal/provenance.ts"),
  source("ALGAL puzzle suite and verification", "clankdar", "docs/clankdar-algal-v1.md"),
  source("Integer scoring", "clankdar", "ladder/family.ts"),
  source("Scoring examples and evaluator checks", "clankdar", "ladder/algal.test.ts"),
  source("Receipt verification and application checks", "clankdar", "cloudflare/examples/verify-receipt.mjs"),
] as const;

export const POSTS: readonly BlogPost[] = [
  {
    slug: "introducing-clankdar",
    path: "/blog/introducing-clankdar",
    launch: true,
    title: "Introducing Clankdar",
    dek: "Clankdar tests AI agents on fresh puzzles whose answers a program computes, so no judge model decides whether a reply is right.",
    cardDek: "Fresh puzzles with computed answers and results you can recheck.",
    eyebrow: "Introducing",
    cardEyebrow: "Release",
    published: "2026-09-24",
    updated: "2026-10-01",
    tags: ["agents", "benchmarks", "evaluation", "algal"],
    sources: introducingSources,
    admission: {
      href: "/blog/introducing-clankdar",
      lifecycle: "indexable",
      readerJob: "Decide in a minute whether Clankdar's exactly scored, signed puzzle checks fit an agent you run or rely on, then solve a practice puzzle or run the local demo.",
      nonObviousAnswer: "A signed Clankdar result can be rechecked offline by anyone with the issuer's public key, and editing one recorded answer (515 to 514 in the recorded demo) makes the verifier reject the whole file; an agent that guesses wrong still gets a signed, failing result.",
      originalContribution: "Ten standalone beats, each shown with a mockup drawn from real recorded runs: a passing demo, a failing custom solver, and a tampered result the repository's verifier rejects.",
      hostFit: "The product's own introduction on its own host, in the Introducing (beats) shape from ARTICLE_COPY.md; technical depth stays in the docs and the ALGAL companion post.",
      nearestUrls: [
        { url: "/", distinction: "The homepage lets a reader try a puzzle; the post explains why the scoring needs no judge and who should use it." },
        { url: "/docs/", distinction: "The docs are the integration reference; the post is the reasoning and first run, and links to the docs for limits." },
        { url: "/benchmark/", distinction: "The benchmark page compares recorded model responses; the introduction explains an individual check and its result." },
      ],
      sources: admissionSources(introducingSources),
      observations: [
        "Every number in the beats comes from site/launch/facts.ts, which reads the hosted policy, the ALGAL worked example, and the family list from the code; launch.test.ts pins them.",
        "The mockups render values from recorded bun run try runs in site/launch/fixtures; launch.test.ts verifies the passing and failing receipts with the repository verifier and confirms the tampered one is rejected.",
        "The staging limits after the beats match the limits STYLE.md requires every Clankdar page to keep whenever it states them.",
      ],
      scores: { readerUtility: 2, originalEvidence: 2, factualConfidence: 2, hostFit: 2, voiceIntegrity: 1, maintenanceValue: 2 },
      owner: "Hraness",
      drafting: "ai-from-source",
      review: LAUNCH_REVIEW,
      humanReview: null,
      reassessOn: "2026-11-05",
      harmIfWrong: "A reader could treat a demo or suite-v2 score as an ALGAL model score, or rely on staging limits that have changed.",
      refreshTriggers: [
        "ALGAL evaluator pin or clankdar-algal-v1 suite version changes (docs/clankdar-algal-v1.md, package.json)",
        "ALGAL model scores are published or a calibration is recorded",
        "Benchmark page main comparison moves off clankdar-suite-v2 or the family count in ladder/mod.ts changes",
        "Hosted staging policy or limits change (README.md, STYLE.md), or the API leaves invitation-only staging",
        "A packaged release ships (status sentence)",
        "Demo command, solver contract, Bun version, or bench flags change (README.md, bench/options.ts)",
        "Canonical messaging lines in STYLE.md change",
        "Relation runtime:clankdar:algal:scores-puzzles-with changes or is removed",
        "docs #security or site #try anchors move",
      ],
    },
  },
  {
    slug: "how-clankdar-uses-algal",
    path: "/blog/how-clankdar-uses-algal",
    title: "How Clankdar uses ALGAL for reference answers",
    dek: "Clankdar uses ALGAL to compute puzzle answers and reproduce their scores from a recorded set of rules.",
    cardDek: "ALGAL computes each default puzzle's answer.",
    cardTitle: "How Clankdar uses ALGAL",
    eyebrow: "Integration",
    published: "2026-09-24",
    updated: "2026-10-01",
    tags: ["clankdar", "algal", "evaluation", "benchmarks", "replay", "agents"],
    sources: usesSources,
    admission: {
      href: "/blog/how-clankdar-uses-algal",
      lifecycle: "indexable",
      readerJob: "Decide whether a Clankdar score on the default puzzles can be trusted and rechecked without trusting a judge model or the person who ran it.",
      nonObviousAnswer: "Clankdar never reimplements ALGAL: it loads ALGAL's own WebAssembly evaluator at a pinned commit, checks the file's SHA-256 before use, tests that the module takes no host imports and agrees with ALGAL's official loader, and any change to that pin or the generator requires a new suite name, so replay can rebuild each puzzle from suite, type and seed and fail the whole run on any mismatch.",
      originalContribution: "The scoring cases from Clankdar's tests and the pinning and replay rules, explained from the consumer's side.",
      hostFit: "The registered runtime:clankdar:algal:scores-puzzles-with relation carries the detail sentence this post explains, on the consumer's host.",
      nearestUrls: [
        { url: "/blog/introducing-clankdar", distinction: "The introduction covers the product; this post covers only the ALGAL integration." },
        { url: "https://algal.computer/blog/built-on-algal/", distinction: "The provider hub lists consumers; this post explains one of them in depth." },
      ],
      sources: admissionSources(usesSources),
      observations: [
        "The scoring table's four cases are taken from Clankdar's own test file rather than restated from the spec.",
        "The worked example returns 34; the suite fixes its evaluator and generation rules so a recorded puzzle can be regenerated.",
      ],
      scores: { readerUtility: 2, originalEvidence: 1, factualConfidence: 2, hostFit: 2, voiceIntegrity: 2, maintenanceValue: 2 },
      owner: "Hraness",
      drafting: "ai-from-source",
      review: REVIEW,
      humanReview: null,
      reassessOn: "2026-11-05",
      harmIfWrong: "A reader could trust a pinned evaluator claim or scoring rule that has since changed.",
      refreshTriggers: [
        "Registration of runtime:clankdar:algal:scores-puzzles-with with its detail sentence in @hraness/design-kit/portfolio on main (reassess hostFit), or any later change to that detail",
        "Change to the @hraness/algal pin, the WASM SHA-256, the algal.expr.v1 contract, or the 10,000 fuel budget (ladder/algal/provenance.ts, package.json)",
        "A new suite name replacing clankdar-algal-v1, or a change to its three puzzle types (docs/clankdar-algal-v1.md, ladder/mod.ts)",
        "Change to algal-floor-v1 (four puzzles, three correct, 180 seconds) or to receipt and signed-record behavior (README.md)",
        "Change to integer scoring cases (ladder/family.ts, ladder/algal.test.ts) or replay rules (bench/replay.ts)",
        "Publication of ALGAL model scores on the benchmark page, or a Clankdar status change from Preview",
        "algal.computer/blog/built-on-algal or hraness.com/reference/correctness/verifying-receipts-offline going live",
        "Change to the worked example's Bun version or commands, or a rename of Clankdar or ALGAL",
      ],
    },
  },
];

export const ADMISSIONS: readonly ArticleAdmission[] = POSTS.map(post => post.admission);
