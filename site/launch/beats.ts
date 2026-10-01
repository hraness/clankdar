/**
 * The "Introducing Clankdar" launch post as beats: bite-size, standalone
 * posts, each with one visual. The post renders them in order and the social
 * kit (X, Bluesky, Threads, LinkedIn, and the Show HN and Product Hunt fact
 * sheet) is cut straight from them, so a number or claim changes in one place.
 *
 * Every number is a `{placeholder}` into LAUNCH_FACTS; the status comes from
 * LAUNCH_RELEASE. `assertLaunchKit` in launch.test.ts enforces the channel
 * limits and the STYLE.md bans.
 */
import {
  assertLaunchKit,
  LaunchKitError,
  buildSocialKit,
  resolveLaunchBeats,
  type LaunchBeat,
  type SocialKit,
} from "@hraness/design-kit/launch";
import { LAUNCH_FACTS, LAUNCH_MESSAGING, LAUNCH_POST_URL, LAUNCH_RELEASE, PUBLIC_INSTALL } from "./facts.ts";

export const LAUNCH_BEAT_SOURCE: readonly LaunchBeat[] = Object.freeze([
  {
    id: "what",
    part: "what",
    headline: "Check what your AI agent can solve",
    post: "Clankdar gives your AI agent fresh puzzles, checks every answer exactly, and signs the result so anyone can recheck it. No second AI grades the work.",
    visual: { kind: "mockup", id: "try-run", state: { run: "pass" } },
    alt: "The local demo in a terminal, in an illustration of a recorded run: every puzzle passes and the result verifies.",
  },
  {
    id: "exact",
    part: "does",
    headline: "Right or wrong, with no judge model",
    post: "Take {exampleValues}, keep the numbers over {exampleCutoff}, square them, and add them up. The answer is {exampleAnswer}. An agent that says {exampleWrong} fails, because the integer differs. A program computes every answer.",
    socialPost: "Here is a Clankdar puzzle: take {exampleValues}, keep the numbers over {exampleCutoff}, square them and add them up. The answer is {exampleAnswer}. An agent that says {exampleWrong} fails, because the integer differs. A program computes every answer.",
    facts: ["exampleValues", "exampleCutoff", "exampleAnswer", "exampleWrong"],
    visual: { kind: "mockup", id: "score-split", state: {} },
    alt: "One puzzle scored twice, in an illustration: the reply {exampleAnswer} passes and the reply {exampleWrong} fails.",
  },
  {
    id: "fresh",
    part: "does",
    headline: "Fresh puzzles every time",
    post: "Clankdar generates each check from a fresh seed. Your agent gets {policyPuzzles} puzzles, needs {policyPasses} correct answers, and has {policySeconds} seconds to submit them under the default policy.",
    facts: ["policyPuzzles", "policyPasses", "policySeconds"],
    visual: { kind: "mockup", id: "puzzle", state: {} },
    alt: "One freshly made puzzle, in an illustration: its program, its inputs, and the time the check closes.",
  },
  {
    id: "signed",
    part: "does",
    headline: "A signed result anyone can recheck",
    post: "When you submit answers, Clankdar signs a record of the puzzles, the answers, the deadline, and the verdict. Anyone with the issuer's public key can check the signature offline and see each expected answer next to the reply.",
    visual: { kind: "mockup", id: "result", state: { view: "summary" } },
    alt: "A signed result, in an illustration of a recorded run: the pass, the deadline, and each expected answer beside the reply.",
    detailHref: "/docs/#verification",
  },
  {
    id: "tamper",
    part: "does",
    headline: "Change one answer and the signature breaks",
    post: "Edit a single answer in a signed result, say {tamperFrom} to {tamperTo}, and the verifier rejects the whole file. The original signature no longer matches the edited result.",
    socialPost: "Change a single answer in a signed result, even by one, and the verifier rejects the whole file. The original signature no longer matches the edited result.",
    facts: ["tamperFrom", "tamperTo"],
    visual: { kind: "mockup", id: "verify", state: { file: "tampered" } },
    alt: "A result with one answer changed from {tamperFrom} to {tamperTo}, in an illustration of a recorded run: the verifier rejects it.",
  },
  {
    id: "how",
    part: "how",
    headline: "Your agent, your model, your keys",
    post: "For a check, your code fetches the puzzles, passes them to your agent, and submits its answers. An agent that guesses wrong gets a failing result, signed all the same.",
    visual: { kind: "mockup", id: "try-run", state: { run: "own-solver" } },
    alt: "A custom solver that answers every puzzle wrong, in an illustration of a recorded run: the check reports FAIL.",
    detailHref: "/docs/#own-solver",
  },
  {
    id: "who",
    part: "who",
    headline: "For anyone handing work to an agent",
    post: "Ask an agent for a fresh result before you give it a job, compare two versions before a release, or show what an agent solved next to its listing. Your app decides which result is good enough.",
    visual: { kind: "mockup", id: "listing", state: {} },
    alt: "A made-up agent directory listing, in an illustration: the agent's latest check result and when it ran.",
    detailHref: "/docs/#integrate",
  },
  {
    id: "vision",
    part: "vision",
    headline: "Claims about agents should come with evidence",
    post: "A result is more useful when you can inspect the questions and rescore the answers. Clankdar keeps that information in a portable signed file, so the person reading a score can verify the work behind it.",
    visual: { kind: "mockup", id: "verify", state: { file: "original" } },
    alt: "A signed result checked offline with the issuer's key, in an illustration of a recorded run: it verifies.",
  },
  {
    id: "limits",
    part: "limits",
    headline: "What a passing check doesn't prove",
    post: "A pass records correct answers under the issuer’s deadline. It doesn't show which model answered, that an agent is safe, or that it may act for you. It scores questions with one right answer.",
    visual: { kind: "mockup", id: "result", state: { view: "limits" } },
    alt: "A signed check result, in an illustration, next to a list of what a pass shows and what it does not show.",
    detailHref: "/docs/#security",
  },
  {
    id: "status",
    part: "status",
    headline: "Free to run on your own machine",
    post: "Clankdar is in Preview. Run the local demo from source with Bun, without an account or API key. The hosted API is an experimental staging service, open by invitation.",
    socialPost: "Clankdar is in Preview. Run the local demo from source with Bun, without an account or API key.",
    visual: { kind: "mockup", id: "try-run", state: { run: "start" } },
    alt: "An illustration of a terminal cloning the Clankdar repository and starting the local demo with Bun.",
  },
] as readonly LaunchBeat[]);

/** The beats with every placeholder filled from LAUNCH_FACTS. */
export const LAUNCH_BEATS: readonly LaunchBeat[] = resolveLaunchBeats(LAUNCH_BEAT_SOURCE, LAUNCH_FACTS);

export const LAUNCH_SOCIAL_KIT: SocialKit = buildSocialKit(LAUNCH_BEATS, LAUNCH_MESSAGING, LAUNCH_RELEASE, LAUNCH_POST_URL);

/**
 * The one known kit problem: the registry's canonical meta description (the
 * Product Hunt description) says "receipt", which the shared kit lists as
 * internal vocabulary. For Clankdar the word is deliberate public copy:
 * STYLE.md ("Repository additions") names *receipt* as the public name for a
 * check's signed result, and the meta line comes from the portfolio registry
 * (portfolio-messaging.generated.json), so it is not edited here. The beats
 * still say "signed result" so each post stands alone without the gloss.
 */
export const KNOWN_KIT_PROBLEMS: readonly string[] = Object.freeze([
  'Product Hunt description uses the internal word "receipt".',
]);

/** Every kit problem apart from KNOWN_KIT_PROBLEMS; empty when the kit is clean. */
export function launchKitProblems(): string[] {
  try {
    assertLaunchKit(LAUNCH_BEATS, LAUNCH_SOCIAL_KIT, {
      status: LAUNCH_RELEASE.status,
      publicInstall: PUBLIC_INSTALL,
      tagline: LAUNCH_MESSAGING.tagline,
      canonicalUrl: LAUNCH_POST_URL,
    });
    return [];
  } catch (error) {
    if (!(error instanceof LaunchKitError)) throw error;
    return error.problems.filter(problem => !KNOWN_KIT_PROBLEMS.includes(problem));
  }
}

const unexpected = launchKitProblems();
if (unexpected.length > 0) throw new LaunchKitError(unexpected);
