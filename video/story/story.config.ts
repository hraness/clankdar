/**
 * Clankdar's launch film: claims about agents come without the test, the
 * reveal, the worked puzzle that fails a near miss, fresh puzzles and a signed
 * result, the default check's numbers, what a pass doesn't prove, and an end
 * card that opens the site. Every value comes from site/launch/facts.ts. There
 * is no packaged release (PUBLIC_INSTALL is false), so the film never asks
 * anyone to install.
 */
import { join } from "node:path";

import { LAUNCH_FACTS, LAUNCH_RELEASE } from "../../site/launch/facts.ts";
import { defineStory } from "./story.ts";
import palette from "./palette.json" with { type: "json" };

const repo = join(import.meta.dir, "../..");
const f = (key: keyof typeof LAUNCH_FACTS) => LAUNCH_FACTS[key].value;

export default () => defineStory({
  id: "clankdar",
  brand: {
    wordmark: "Clankdar",
    mark: join(repo, "site/marks/clankdar.svg"),
    markAspect: 615 / 621,
    // Read with site-palette.ts from https://clankdar.com in dark mode; see palette.json.
    palette: { values: palette.palette },
    designKit: join(repo, "node_modules/@hraness/design-kit"),
  },
  acts: [
    {
      kind: "scatter", headline: "You hear an agent is good, but you never see the test.", accents: ["see", "the", "test."],
      cards: [
        { app: "Leaderboard", glyph: "#", color: "#7aa2f7", lines: ["A number", "No questions shown"] },
        { app: "Demo video", glyph: "▶", color: "#e0af68", lines: ["Picked examples", "Nothing to rerun"] },
        { app: "Judge model", glyph: "J", color: "#f7768e", lines: ["Another AI", "grades the work"] },
      ],
      ghosts: ["Screenshot", "Testimonial", "Press release", "Benchmark chart", "Anecdote"],
    },
    { kind: "reveal", tagline: "Check what your AI agent can solve." },
    { kind: "chat", headline: "Every answer is checked exactly, with no judge model.", accents: ["exactly,"], label: "A Clankdar puzzle", exchanges: [
      {
        you: `Take ${f("exampleValues")}, keep the numbers over ${f("exampleCutoff")}, square them, and add them up.`,
        agent: f("exampleWrong"),
        card: { kicker: "Fail", title: `The answer is ${f("exampleAnswer")}`, body: "A near miss is still wrong." },
      },
    ] },
    {
      kind: "stats", headline: "Fresh puzzles every time, from a new seed.", accents: ["Fresh"],
      items: [
        { value: f("policyPuzzles"), label: "puzzles in the default check" },
        { value: f("policyPasses"), label: "correct answers needed to pass" },
        { value: f("policySeconds"), label: "seconds to submit them" },
      ],
    },
    {
      kind: "cards", headline: "The result is signed, so anyone can recheck it.", accents: ["signed,"],
      items: [
        { tag: "Offline", title: "Anyone with the issuer's public key can verify it" },
        { tag: "Tamper", title: `Change one answer, ${f("tamperFrom")} to ${f("tamperTo")}, and the signature breaks` },
        { tag: "Your agent", title: "Your code passes the puzzles to your agent and submits its answers" },
      ],
    },
    {
      kind: "cards", headline: "A pass records correct answers, nothing more.", accents: ["nothing", "more."],
      items: [
        { tag: "Not shown", title: "Which model answered" },
        { tag: "Not shown", title: "That an agent is safe, or may act for you" },
      ],
    },
  ],
  end: { action: "See how it works at clankdar.com", terms: `${LAUNCH_RELEASE.status} · Free to run on your own machine`, url: "clankdar.com" },
  formats: ["wide", "square", "portrait"],
});
