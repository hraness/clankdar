/**
 * The launch film's copy and product surfaces.
 *
 * Every number comes from site/launch/facts.ts and every surface is one of the
 * site's own launch mockups (site/launch/mockups.tsx), driven by the same
 * recorded runs as the launch post. Illustration only: the cold-open claims
 * and the listing are made up.
 */
import type { ReactNode } from "react";
import { LAUNCH_FACTS } from "../../site/launch/facts.ts";
import { Puzzle, Result, ScoreSplit, Verify } from "../../site/launch/mockups.tsx";
import type { FilmCopy } from "./timeline.ts";

const fact = (key: keyof typeof LAUNCH_FACTS) => LAUNCH_FACTS[key].value;
const count = (key: keyof typeof LAUNCH_FACTS) => Number(fact(key).replaceAll(",", ""));

export const FILM = Object.freeze({
  name: "Introducing Clankdar",
  fps: 30,
  seed: 20260929,
  background: "#16161e",
  /** Tokyo Night blue, the site's palette accent. */
  accent: "#7aa2f7",
});

export const FILM_COPY: FilmCopy = Object.freeze({
  name: "Clankdar",
  promise: "Check what your AI agent can solve.",
  url: "clankdar.com",
  open: ["Every agent says it can do the job.", "Few can show you."],
  steps: [
    {
      heading: "A fresh puzzle",
      body: "Each check deals new puzzles from a random seed, so there is no answer key to learn.",
      focus: "puzzle",
      target: "puzzle",
      highlight: "puzzle",
      zoom: 1.75,
    },
    {
      heading: "Exact scoring",
      body: `The answer is ${fact("exampleAnswer")}. A reply of ${fact("exampleWrong")} fails. No second AI grades the work.`,
      focus: "score",
      target: "score",
      highlight: "score",
      zoom: 1.75,
    },
    {
      heading: "A signed result",
      body: `${fact("policyPasses")} of ${fact("policyPuzzles")} right passes. The result is signed so anyone can recheck it.`,
      focus: "result",
      target: "result",
      highlight: "result",
      zoom: 1.75,
    },
    {
      heading: "Tamper shows",
      body: `Change one answer from ${fact("tamperFrom")} to ${fact("tamperTo")} and the signature check fails.`,
      focus: "verify",
      target: "verify",
      highlight: "verify",
      zoom: 1.75,
    },
  ],
  proof: {
    caption: "The default hosted check, from the code.",
    items: [
      { value: count("policyPuzzles"), label: "puzzles per check" },
      { value: count("policyPasses"), label: "right answers to pass" },
      { value: count("policySeconds"), suffix: " s", label: "to answer" },
    ],
  },
  limits: {
    heading: "What a pass doesn't prove",
    body: "Which model answered, that an agent is safe, or that it may act for you.",
  },
  end: { line: "Preview. Run the demo from source, free." },
});

function Cell({ name, children }: Readonly<{ name: string; children: ReactNode }>) {
  return <div className="cdf-cell" data-film={name}>{children}</div>;
}

/** The four surfaces the camera walks, laid out as one page. */
export function FilmSurface() {
  return (
    <div className="cdf-surface" data-film-page="">
      <Cell name="puzzle"><Puzzle describe="A fresh puzzle from a recorded check, in an illustration." theme="light" /></Cell>
      <Cell name="score"><ScoreSplit describe="One puzzle scored twice, in an illustration." theme="light" /></Cell>
      <Cell name="result"><Result describe="The signed result of a recorded check, in an illustration." theme="light" view="summary" /></Cell>
      <Cell name="verify"><Verify describe="A tampered result rejected by the offline verifier, in an illustration." file="tampered" theme="dark" /></Cell>
    </div>
  );
}

/** Made-up agent claims for the cold open. No real product or account. */
const CLAIMS = [
  "Handles any task you throw at it",
  "Best reasoning on the market",
  "Trusted by teams everywhere",
  "Never gets the math wrong",
  "Your new senior engineer",
  "Solves it on the first try",
];

export function OpenCard({ index }: Readonly<{ index: number }>) {
  return (
    <div className="fm-card">
      <span className="fm-avatar" aria-hidden="true">{String.fromCharCode(65 + index)}</span>
      <div>
        <b>Agent {String.fromCharCode(65 + index)}</b>
        <p>{CLAIMS[index % CLAIMS.length]}</p>
      </div>
    </div>
  );
}

