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
/** Ben Guo approved both posts unchanged in the 2026-10-04 portfolio editorial pass. */
const HUMAN_REVIEW = {
  reviewer: "Ben Guo",
  reviewerType: "human-editor",
  reviewedOn: "2026-10-04",
} as const;
/** Independent source and editorial review of the held-out-pool and receipt-scope posts. */
const DETECTION_REVIEW = {
  reviewer: "Devin (SWE-2 Max model)",
  reviewerType: "ai",
  reviewedOn: "2026-10-05",
} as const;
/** Ben Guo approved the detection-evidence expansion in the 2026-10-05 portfolio expansion. */
const DETECTION_HUMAN_REVIEW = {
  reviewer: "Ben Guo",
  reviewerType: "human-editor",
  reviewedOn: "2026-10-05",
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

const holdoutSources = [
  source("Pool format, label mixing, and poolKey commitment", "clankdar", "bench/holdout.ts"),
  source("Holdout wire format, checking outcomes, and limits", "clankdar", "docs/clankdar-attest-v1.md"),
  source("Challenge held-out marker and pool binding", "clankdar", "bench/attest.ts"),
  source("unreplayed counts in badge aggregation", "clankdar", "bench/badge.ts"),
  source("Gate sessions over sealed challenges", "clankdar", "bench/gate.ts"),
] as const;

const receiptScopeSources = [
  source("Receipt shape, commitments, and checking", "clankdar", "bench/attest.ts"),
  source("Session admissions and their stated scope", "clankdar", "bench/gate.ts"),
  source("Transparency log and equivocation detection", "clankdar", "bench/tlog.ts"),
  source("Wire format and threat model", "clankdar", "docs/clankdar-attest-v1.md"),
  source("Offline receipt verification", "clankdar", "cloudflare/examples/verify-receipt.mjs"),
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
      humanReview: HUMAN_REVIEW,
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
      humanReview: HUMAN_REVIEW,
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
  {
    slug: "held-out-puzzles",
    path: "/blog/held-out-puzzles",
    title: "How Clankdar holds puzzles out without hiding the rules",
    dek: "A held-out pool re-parameterizes a published puzzle generator with a secret label, so the rules stay public while the exact instances stay fresh.",
    cardDek: "Public generators, a secret stream, checkable either way.",
    cardTitle: "How Clankdar holds puzzles out",
    eyebrow: "Mechanics",
    published: "2026-10-05",
    tags: ["evaluation", "benchmarks", "contamination", "held-out", "agents"],
    sources: holdoutSources,
    admission: {
      href: "/blog/held-out-puzzles",
      lifecycle: "indexable",
      readerJob: "Decide whether a held-out Clankdar result is meaningful evidence that an agent was not reciting a benchmark it had seen, and what you can and cannot check before the issuer publishes its pool.",
      nonObviousAnswer: "The generators are fully published; only a >=128-bit label per cell is private, and the whole pool commits to a poolKey. Without the pool a held-out receipt verifies its envelope but reports replayable:false and counts in unreplayed; publishing the pool later upgrades every historical receipt under it to fully verifiable, including cell-list soundness.",
      originalContribution: "The three checking outcomes, the unreplayed accounting, and the deferred-disclosure accountability hook taken from the wire format's own limits section; including that a sound solver still solves held-out cells.",
      hostFit: "Explains clankdar-holdout-v1, a shipped protocol with its spec section, on the product's own host; complements the ALGAL post's published-pool scoring rather than repeating it.",
      nearestUrls: [
        { url: "/blog/how-clankdar-uses-algal", distinction: "The ALGAL post covers replaying published-suite scores; this post covers held-out cells whose scores stay issuer-claimed until pool disclosure." },
        { url: "/blog/what-a-receipt-proves", distinction: "The receipt post scopes what signed evidence attests; this post covers the anti-memorization mechanism one kind of challenge uses." },
        { url: "/docs/", distinction: "The docs are the integration reference; this post explains why held-out pools exist and what checkers see at each disclosure state." },
      ],
      sources: admissionSources(holdoutSources),
      observations: [
        "The held-out instance definition generate(tier, mixSeed(label, seed)), the >=128-bit label bound, and the h:family:tN policy syntax are taken from docs/clankdar-attest-v1.md section 15 and bench/holdout.ts.",
        "The three checking outcomes (verified, invalid, issuer-claimed with replayable:false) and the unreplayed count are from the spec's checking rules and their bench/attest.ts and bench/badge.ts implementations.",
        "The limits; a general family solver still solves held-out cells, a finite generator can repeat an instance, and poolKey commits to a pool but not a sound one; are restated from the spec's own limits, not softened.",
      ],
      scores: { readerUtility: 2, originalEvidence: 2, factualConfidence: 2, hostFit: 2, voiceIntegrity: 2, maintenanceValue: 1 },
      owner: "Hraness",
      drafting: "ai-from-source",
      review: DETECTION_REVIEW,
      humanReview: DETECTION_HUMAN_REVIEW,
      reassessOn: "2026-11-05",
      harmIfWrong: "A reader could believe a held-out score proves anti-memorization it does not, or overlook that unreplayed cells are issuer claims until pool disclosure.",
      refreshTriggers: [
        "Change to clankdar-holdout-v1: label bounds, mixSeed, poolKey commitment, or h: policy syntax (docs/clankdar-attest-v1.md, bench/holdout.ts)",
        "Change to held-out checking outcomes, the replayable flag, or unreplayed accounting (bench/attest.ts, bench/badge.ts, bench/tlog.ts)",
        "A published pool, disclosed label scheme, or new holdout version changes the disclosure story",
        "Change to gate policy cells or challenge markers (bench/gate.ts, bench/attest.ts)",
        "Rename of Clankdar or restructuring of the spec's section 15",
      ],
    },
  },
  {
    slug: "what-a-receipt-proves",
    path: "/blog/what-a-receipt-proves",
    title: "What a Clankdar receipt proves and what it doesn't",
    dek: "A signed receipt attests one scored response inside one window; an admission attests a session verdict under one policy. Neither is identity, liveness, or authority.",
    cardDek: "Signed evidence of one scored episode; never identity.",
    cardTitle: "What a Clankdar receipt proves",
    eyebrow: "Explainer",
    published: "2026-10-05",
    tags: ["receipts", "verification", "evaluation", "agents", "transparency"],
    sources: receiptScopeSources,
    admission: {
      href: "/blog/what-a-receipt-proves",
      lifecycle: "indexable",
      readerJob: "Read a signed Clankdar result correctly: know which claims the signature, seed commitments, and verdict actually establish, and which questions about the agent stay open.",
      nonObviousAnswer: "The cryptography does not decide whether a result is evidence: a valid signature can accompany a failing score, a held-out receipt can verify its envelope while its score stays issuer-claimed, and even a fully replayable admission attests only one scored session; challenges can be delegated, and an issuer can answer its own oracle.",
      originalContribution: "The scope boundaries stated in the product's own threat model; receipt vs admission, the three permanent non-claims, delegation, self-answering issuers, and the transparency log's same-key binding; organized as a reading order for a signed result.",
      hostFit: "States the evidence contract the whole product rests on, on the product's own host, using only limits the spec and the AGENTS claims ledger already record.",
      nearestUrls: [
        { url: "/blog/introducing-clankdar", distinction: "The introduction shows a first check end to end; this post scopes what its signed output means." },
        { url: "/blog/held-out-puzzles", distinction: "The holdout post covers one challenge kind's freshness mechanism; this post covers what any signed record does and does not attest." },
        { url: "/docs/", distinction: "The docs give the verification commands and API shapes; this post explains how to interpret what they return." },
      ],
      sources: admissionSources(receiptScopeSources),
      observations: [
        "The episode scope; one session, K passing responses, one policy, one window; and the delegation and self-oracle caveats are quoted from bench/gate.ts's protocol comment, which states them as the wire contract.",
        "The tamper example (515 to 514 rejected) is the repository's recorded demo fixture, already verified by launch.test.ts against the repository verifier.",
        "The transparency log claims are bounded to what is implemented: hash-chained signed log, witness equivocation detection, fork comparison, linear consistency proofs; provider discovery and witnessed co-signing are explicitly not claimed.",
      ],
      scores: { readerUtility: 2, originalEvidence: 1, factualConfidence: 2, hostFit: 2, voiceIntegrity: 2, maintenanceValue: 2 },
      owner: "Hraness",
      drafting: "ai-from-source",
      review: DETECTION_REVIEW,
      humanReview: DETECTION_HUMAN_REVIEW,
      reassessOn: "2026-11-05",
      harmIfWrong: "A reader could over-trust a signed result; treating it as identity, liveness, or authority; or under-trust a legitimately replayable one.",
      refreshTriggers: [
        "Change to receipt or admission scope statements (bench/attest.ts, bench/gate.ts protocol comments, docs/clankdar-attest-v1.md)",
        "Subject binding, delegation handling, or issuer self-answering behavior changes",
        "clankdar-tlog-v1 gains provider discovery, witnessed co-signing, or external anchoring, or its consistency proof changes shape",
        "Change to verification commands or the tampered-fixture example (cloudflare/examples/verify-receipt.mjs, site/launch/fixtures.ts)",
        "Rename of Clankdar",
      ],
    },
  },
];

export const ADMISSIONS: readonly ArticleAdmission[] = POSTS.map(post => post.admission);
