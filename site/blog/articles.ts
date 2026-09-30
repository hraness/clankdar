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
const SOURCES_CHECKED_ON: ArticleIsoDate = "2026-09-24";
/** The latest AI editorial review: a line and structure edit on 2026-09-26 that kept every fact. */
const REVIEW = {
  reviewer: "Claude Opus 5.5 (claude-opus-5-5) editorial review",
  reviewerType: "ai",
  reviewedOn: "2026-09-26",
} as const;

/**
 * The launch post's independent AI review on 2026-09-30, by an agent that did
 * not draft or edit the post: it scored 10 of 12 with no zero, rechecked every
 * number against site/launch/facts.ts and its code source, and asked for the
 * single status statement and standalone social wording applied the same day.
 */
const LAUNCH_REVIEW = {
  reviewer: "Claude Opus 5.5 (claude-opus-5-5) independent AI review",
  reviewerType: "ai",
  reviewedOn: "2026-09-30",
} as const;

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
  source("Launch facts: every number in the beats and where it comes from", "clankdar", "site/launch/facts.ts", "2026-09-29"),
  source("Recorded demo, failing and tampered runs behind the mockups", "clankdar", "site/launch/fixtures.ts", "2026-09-29"),
  source("Offline receipt verifier", "clankdar", "cloudflare/examples/verify-receipt.mjs", "2026-09-29"),
  source("Clankdar README: what the evidence means, policy and staging limits", "clankdar", "README.md"),
  source("Clankdar's ALGAL suite (clankdar-algal-v1)", "clankdar", "docs/clankdar-algal-v1.md"),
  source("ALGAL puzzle generator and reference solver", "clankdar", "ladder/families/algal.ts"),
  source("Puzzle families and suite versions", "clankdar", "ladder/mod.ts"),
  source("Replay of recorded runs", "clankdar", "bench/replay.ts"),
  source("Benchmark and reference tools guide", "clankdar", "docs/reference-tools.md"),
  source("Model benchmark page", "clankdar", "site/benchmark/index.html"),
] as const;

const usesSources = [
  source("ALGAL dependency pinned by commit (@hraness/algal)", "clankdar", "package.json"),
  source("Puzzle generator; reference answers come from ALGAL execution, never a second implementation", "clankdar", "ladder/families/algal.ts"),
  source("Evaluator pin: revision, WASM SHA-256, language contract, work budget", "clankdar", "ladder/algal/provenance.ts"),
  source("Clankdar's ALGAL suite (clankdar-algal-v1): puzzle types, pins, limits, verification, compatibility", "clankdar", "docs/clankdar-algal-v1.md"),
  source("Hosted default policy algal-floor-v1 and what the evidence means", "clankdar", "README.md"),
  source("Replay of recorded runs against regenerated puzzles", "clankdar", "bench/replay.ts"),
  source("Suite versions and frozen pools", "clankdar", "ladder/mod.ts"),
  source("Exact integer scoring", "clankdar", "ladder/family.ts"),
  source("Tests: evaluator hash, no host imports, agreement with ALGAL's official loader, scoring cases", "clankdar", "ladder/algal.test.ts"),
  source("algal.expr.v1 contract: programs as JSON data, one Rust evaluator for every runtime, metered work", "algal", "spec/v1/expr.md"),
  source("ALGAL README: what ALGAL is", "algal", "README.md"),
] as const;

export const POSTS: readonly BlogPost[] = [
  {
    slug: "introducing-clankdar",
    path: "/blog/introducing-clankdar",
    launch: true,
    title: "Introducing Clankdar",
    dek: "Clankdar tests AI agents on fresh puzzles whose answers a program computes, so no judge model decides whether a reply is right.",
    cardDek: "Fresh puzzles whose answers a program computes, not a judge model.",
    eyebrow: "Introducing",
    cardEyebrow: "Release",
    published: "2026-09-24",
    updated: "2026-09-30",
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
        { url: "/benchmark/", distinction: "The benchmark page holds recorded scores; the post says which puzzle set those scores come from." },
      ],
      sources: admissionSources(introducingSources),
      observations: [
        "Every number in the beats comes from site/launch/facts.ts, which reads the hosted policy, the ALGAL worked example, and the family list from the code; launch.test.ts pins them.",
        "The mockups render values from recorded bun run try runs in site/launch/fixtures; launch.test.ts verifies the passing and failing receipts with the repository verifier and confirms the tampered one is rejected.",
        "The staging limits after the beats match the limits STYLE.md requires every Clankdar page to keep whenever it states them.",
      ],
      scores: { readerUtility: 2, originalEvidence: 2, factualConfidence: 2, hostFit: 2, voiceIntegrity: 1, maintenanceValue: 1 },
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
    dek: "ALGAL's own evaluator, pinned by commit and WebAssembly hash, computes the reference answer for every default Clankdar puzzle.",
    cardDek: "ALGAL computes each default puzzle's answer.",
    cardTitle: "How Clankdar uses ALGAL",
    eyebrow: "Integration",
    published: "2026-09-24",
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
        "The post names the 16 MiB figure as a check on retained memory, not a peak-use limit.",
      ],
      scores: { readerUtility: 2, originalEvidence: 1, factualConfidence: 2, hostFit: 2, voiceIntegrity: 2, maintenanceValue: 1 },
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
        "Change to the 64 KiB request and response caps or the 16 MiB retained-memory check",
        "Publication of ALGAL model scores on the benchmark page, or a Clankdar status change from Preview",
        "algal.computer/blog/built-on-algal or hraness.com/reference/correctness/verifying-receipts-offline going live",
        "Change to the worked example's Bun version or commands, or a rename of Clankdar or ALGAL",
      ],
    },
  },
];

export const ADMISSIONS: readonly ArticleAdmission[] = POSTS.map(post => post.admission);
