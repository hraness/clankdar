/**
 * Clankdar's launch facts: the one typed place for every number the launch
 * post, social kit, film captions and homepage mockups show. Values come from
 * the code that enforces them wherever the code exports them; the rest are
 * pinned against their source in facts.test.ts.
 */
import type { LaunchFact, LaunchFacts, LaunchMessaging, LaunchRelease } from "@hraness/design-kit/launch";
import { HOSTED_POLICIES } from "../../cloudflare/src/challenges.ts";
import { algalWorkedExample } from "../../ladder/families/algal.ts";
import { FAMILIES } from "../../ladder/mod.ts";
import { TAMPER } from "./fixtures.ts";

const policy = HOSTED_POLICIES["algal-floor-v1"]!;
const example = algalWorkedExample();
const fact = (value: string | number, source: string): LaunchFact => Object.freeze({ value: typeof value === "number" ? value.toLocaleString("en-US") : value, source });

export const LAUNCH_FACTS = Object.freeze({
  policyPuzzles: fact(policy.challenges, "cloudflare/src/challenges.ts: HOSTED_POLICIES algal-floor-v1 challenges"),
  policyPasses: fact(policy.minPass, "cloudflare/src/challenges.ts: HOSTED_POLICIES algal-floor-v1 minPass"),
  policySeconds: fact(policy.ttlSeconds, "cloudflare/src/challenges.ts: HOSTED_POLICIES algal-floor-v1 ttlSeconds"),
  stagingTotal: fact(1024, "cloudflare/src/checks.ts: ISSUANCE_CAPACITY; STYLE.md staging limits"),
  stagingPerMinute: fact(60, "cloudflare/src/checks.ts: PER_MINUTE; STYLE.md staging limits"),
  exampleCutoff: fact(2, "ladder/families/algal.ts: algalWorkedExample squaresAbove cutoff"),
  exampleValues: fact((example.inputs.values as number[]).join(", "), "ladder/families/algal.ts: algalWorkedExample inputs"),
  exampleAnswer: fact(example.answer, "ladder/families/algal.ts: algalWorkedExample, run by the pinned ALGAL evaluator"),
  exampleWrong: fact(Number(example.answer) - 1, "Off-by-one reply used to show exact scoring; ladder/family.ts scoreAnswer rejects it"),
  tamperFrom: fact(TAMPER.from, "site/launch/fixtures/tampered-receipt.json: the recorded demo answer before the edit"),
  tamperTo: fact(TAMPER.to, "site/launch/fixtures/tampered-receipt.json: the edited answer verify-receipt.mjs rejects"),
  familyCount: fact(FAMILIES.length, "ladder/mod.ts: FAMILIES (clankdar-suite-v2)"),
  bunVersion: fact("1.3.14", "package.json: packageManager"),
} as const satisfies LaunchFacts);

export type LaunchFactKey = keyof typeof LAUNCH_FACTS;

/** The canonical messaging record from STYLE.md ("Clankdar's canonical messaging record"). */
export const LAUNCH_MESSAGING: LaunchMessaging = Object.freeze({
  names: Object.freeze({ name: "Clankdar" }),
  tagline: "Check what your agent can solve.",
  meta: "Clankdar gives AI agents fresh puzzles to solve, scores their answers exactly, and signs a receipt anyone can recheck.",
});

/**
 * The release record: README.md opens with the status label. There is no
 * packaged release and the hosted API is invitation-only staging, so the kit
 * never asks readers to install.
 */
export const LAUNCH_RELEASE: LaunchRelease = Object.freeze({
  status: "Preview",
  tags: Object.freeze(["Developer Tools", "Artificial Intelligence", "Open Source"]),
});
export const PUBLIC_INSTALL = false;

export const LAUNCH_POST_URL = "https://clankdar.com/blog/introducing-clankdar";

export function launchFactValues(): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(LAUNCH_FACTS).map(([key, entry]) => [key, entry.value]));
}
