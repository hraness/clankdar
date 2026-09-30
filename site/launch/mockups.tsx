/**
 * Code-built mockups of Clankdar's real surfaces: the `bun run try` terminal,
 * one generated puzzle, a signed result, the offline verifier, and a made-up
 * agent listing that shows a result. Every value comes from the recorded runs
 * in fixtures.ts or from LAUNCH_FACTS; nothing is typed in by hand.
 *
 * They render to static HTML at build time (the site CSP allows no inline
 * scripts or style attributes), and the launch film imports the same
 * components so the post and the film always show the same thing.
 */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserFrame, MockupRoot, TerminalFrame, type MockupTheme, type TerminalLine } from "@hraness/design-kit/mockups";
import type { LaunchBeat } from "@hraness/design-kit/launch";
import { DEMO_RESULTS_DIR, DEMO_RUN, FAIL_RESULTS_DIR, FAIL_RUN, TAMPER, shortId } from "./fixtures.ts";
import { LAUNCH_FACTS } from "./facts.ts";

const facts = Object.fromEntries(Object.entries(LAUNCH_FACTS).map(([key, fact]) => [key, fact.value])) as Record<keyof typeof LAUNCH_FACTS, string>;

/** The tier 1 puzzle from the recorded demo run, the one the tamper edit changes. */
const TIER_ONE = DEMO_RUN.puzzles.find(puzzle => puzzle.expected === TAMPER.from)!;
/** Its program and inputs, as the recorded prompt states them. */
export const PUZZLE_SAMPLE = Object.freeze({
  program: ["values", "keep x > cutoff", "square each", "add them up"],
  values: "[11, 13, 6, 5, 15, 1, 3, 4]",
  cutoff: "10",
  answer: TIER_ONE.expected,
});

function utcTime(iso: string): string {
  return `${iso.slice(11, 19)} UTC`;
}

const VERIFY_RUN = `bun cloudflare/examples/verify-receipt.mjs`;

export type TryRunState = "start" | "pass" | "own-solver";

export function tryRunLines(run: TryRunState): TerminalLine[] {
  const start: TerminalLine[] = [
    { kind: "input", text: "git clone https://github.com/hraness/clankdar.git && cd clankdar", beat: "clone" },
    { kind: "input", text: "bun install --frozen-lockfile --ignore-scripts" },
    { kind: "input", text: "bun run try", beat: "run" },
    { kind: "output", text: "Running a fresh local ALGAL check with the scripted demo solver…", tone: "muted" },
  ];
  if (run === "start") return start;
  if (run === "pass") {
    return [
      { kind: "input", text: "bun run try", beat: "run" },
      { kind: "output", text: "Running a fresh local ALGAL check with the scripted demo solver…", tone: "muted" },
      { kind: "output", text: `PASS · ${DEMO_RUN.verdict.passed}/${facts.policyPuzzles} passed · ${DEMO_RUN.verdict.required} required · signature and scores independently verified`, tone: "ok", beat: "verdict" },
      { kind: "output", text: `Receipt: ${DEMO_RESULTS_DIR}/receipt.json` },
      { kind: "output", text: `Issuer: ${shortId(DEMO_RUN.issuer)}` },
      { kind: "output", text: `SHA-256: ${shortId(DEMO_RUN.sha256)}` },
      { kind: "output", text: "Local demonstration with an ephemeral issuer. This is not a model score or hosted attestation.", tone: "muted" },
    ];
  }
  return [
    { kind: "comment", text: "my-solver.mjs answers 33 to every puzzle" },
    { kind: "input", text: "bun run try --solver ./my-solver.mjs", beat: "run" },
    { kind: "output", text: "Running a fresh local ALGAL check with your solver…", tone: "muted" },
    { kind: "output", text: `FAIL · ${FAIL_RUN.verdict.passed}/${facts.policyPuzzles} passed · ${FAIL_RUN.verdict.required} required · signature and scores independently verified`, tone: "error", beat: "verdict" },
    { kind: "output", text: `Receipt: ${FAIL_RESULTS_DIR}/receipt.json` },
    { kind: "output", text: `Issuer: ${shortId(FAIL_RUN.issuer)}` },
  ];
}

export function TryRun({ run, describe, theme }: Readonly<{ run: TryRunState; describe: string; theme?: MockupTheme }>) {
  return <TerminalFrame describe={describe} lines={tryRunLines(run)} theme={theme} title="clankdar" />;
}

export type VerifyFile = "original" | "tampered";

export function verifyLines(file: VerifyFile): TerminalLine[] {
  if (file === "tampered") {
    return [
      { kind: "comment", text: `edit one answer in receipt.json: "${TAMPER.from}" → "${TAMPER.to}"`, beat: "edit" },
      { kind: "input", text: `${VERIFY_RUN} tampered.json --issuer ${shortId(DEMO_RUN.issuer, 6)}`, beat: "run" },
      { kind: "output", text: TAMPER.verifierOutput, tone: "error", beat: "verdict" },
    ];
  }
  return [
    { kind: "input", text: `${VERIFY_RUN} receipt.json --issuer ${shortId(DEMO_RUN.issuer, 6)}`, beat: "run" },
    { kind: "output", text: `{"ok":true,"pass":${DEMO_RUN.verdict.pass},"passed":${DEMO_RUN.verdict.passed},"required":${DEMO_RUN.verdict.required},`, tone: "ok", beat: "verdict" },
    { kind: "output", text: ` "sessionId":"${DEMO_RUN.sessionId}","context":"${DEMO_RUN.context}",` },
    { kind: "output", text: ` "decidedAt":"${DEMO_RUN.verdict.decidedAt}"}` },
    { kind: "comment", text: "no network, no account: just the file and the issuer's public key" },
  ];
}

export function Verify({ file, describe, theme }: Readonly<{ file: VerifyFile; describe: string; theme?: MockupTheme }>) {
  return <TerminalFrame describe={describe} lines={verifyLines(file)} theme={theme} title="verify offline" />;
}

function Verdict({ pass }: Readonly<{ pass: boolean }>) {
  return <span className="cdm-verdict" data-pass={pass ? "" : undefined}>{pass ? "PASS" : "FAIL"}</span>;
}

/** The worked example scored twice: the computed answer passes, the near miss fails. */
export function ScoreSplit({ describe, theme }: Readonly<{ describe: string; theme?: MockupTheme }>) {
  const replies = [
    { agent: "Agent A", reply: facts.exampleAnswer, pass: true },
    { agent: "Agent B", reply: facts.exampleWrong, pass: false },
  ];
  return (
    <MockupRoot describe={describe} kind="cdm-card" theme={theme}>
      <div className="cdm-sheet">
        <p className="cdm-label">Puzzle</p>
        <p className="cdm-question">Take {facts.exampleValues}. Keep the numbers over {facts.exampleCutoff}, square them, add them up.</p>
        <p className="cdm-computed">Computed answer <code>{facts.exampleAnswer}</code></p>
        <ul className="cdm-replies">
          {replies.map(entry => (
            <li key={entry.agent}>
              <span className="cdm-agent">{entry.agent} replies</span>
              <code>{entry.reply}</code>
              <Verdict pass={entry.pass} />
            </li>
          ))}
        </ul>
      </div>
    </MockupRoot>
  );
}

/** The tier 1 puzzle from the recorded run, as a solver receives it. */
export function Puzzle({ describe, theme }: Readonly<{ describe: string; theme?: MockupTheme }>) {
  return (
    <MockupRoot describe={describe} kind="cdm-card" theme={theme}>
      <div className="cdm-sheet">
        <p className="cdm-label">Puzzle {DEMO_RUN.puzzles.indexOf(TIER_ONE) + 1} of {facts.policyPuzzles} · tier {TIER_ONE.tier} · fresh seed</p>
        <ol className="cdm-program">
          {PUZZLE_SAMPLE.program.map(step => <li key={step}><code>{step}</code></li>)}
        </ol>
        <dl className="cdm-inputs">
          <div><dt>values</dt><dd><code>{PUZZLE_SAMPLE.values}</code></dd></div>
          <div><dt>cutoff</dt><dd><code>{PUZZLE_SAMPLE.cutoff}</code></dd></div>
        </dl>
        <p className="cdm-note">Reply with only the final integer. Check closes at {utcTime(DEMO_RUN.expiresAt)}, {facts.policySeconds} seconds after it opened.</p>
      </div>
    </MockupRoot>
  );
}

export type ResultView = "summary" | "limits";

const SHOWS = ["Someone answered these puzzles", "Which answers matched, and by when", "The record wasn't changed after signing"];
const DOES_NOT_SHOW = ["Which model answered", "That an agent is safe", "That it may act for you"];

/** The signed result from the recorded demo run, or the same result beside what a pass does and does not show. */
export function Result({ view, describe, theme }: Readonly<{ view: ResultView; describe: string; theme?: MockupTheme }>) {
  const summary = (
    <div className="cdm-sheet">
      <p className="cdm-label">Signed result · {DEMO_RUN.context}</p>
      <p className="cdm-headline"><Verdict pass={DEMO_RUN.verdict.pass} /> {DEMO_RUN.verdict.passed} of {facts.policyPuzzles} right · {DEMO_RUN.verdict.required} needed</p>
      <table className="cdm-table">
        <thead><tr><th scope="col">Puzzle</th><th scope="col">Expected</th><th scope="col">Reply</th><th scope="col">Result</th></tr></thead>
        <tbody>
          {DEMO_RUN.puzzles.map((puzzle, index) => (
            <tr key={puzzle.id}><td>{index + 1} · tier {puzzle.tier}</td><td><code>{puzzle.expected}</code></td><td><code>{puzzle.response}</code></td><td><Verdict pass={puzzle.pass} /></td></tr>
          ))}
        </tbody>
      </table>
      <p className="cdm-note">Closed {utcTime(DEMO_RUN.expiresAt)} · signed by <code>{shortId(DEMO_RUN.issuer, 6)}</code></p>
    </div>
  );
  if (view === "summary") return <MockupRoot describe={describe} kind="cdm-card" theme={theme}>{summary}</MockupRoot>;
  return (
    <MockupRoot describe={describe} kind="cdm-card" theme={theme}>
      <div className="cdm-sheet">
        <p className="cdm-label">Signed result · {DEMO_RUN.context}</p>
        <p className="cdm-headline"><Verdict pass={DEMO_RUN.verdict.pass} /> {DEMO_RUN.verdict.passed} of {facts.policyPuzzles} right · {DEMO_RUN.verdict.required} needed</p>
        <div className="cdm-columns">
          <div><p className="cdm-label">A pass shows</p><ul className="cdm-list" data-tone="ok">{SHOWS.map(item => <li key={item}>{item}</li>)}</ul></div>
          <div><p className="cdm-label">It doesn't show</p><ul className="cdm-list" data-tone="muted">{DOES_NOT_SHOW.map(item => <li key={item}>{item}</li>)}</ul></div>
        </div>
      </div>
    </MockupRoot>
  );
}

/** A made-up agent directory listing that carries its latest result. No real directory or account. */
export function Listing({ describe, theme }: Readonly<{ describe: string; theme?: MockupTheme }>) {
  return (
    <BrowserFrame describe={describe} theme={theme} url="agents.example/tidepool-helper">
      <div className="cdm-listing">
        <div className="cdm-listing-head">
          <span aria-hidden="true" className="cdm-avatar">TH</span>
          <div><p className="cdm-listing-name">Tidepool Helper</p><p className="cdm-note">Sample agent by @ren.example · research and data cleanup</p></div>
        </div>
        <div className="cdm-listing-check">
          <p className="cdm-label">Latest Clankdar check</p>
          <p className="cdm-headline"><Verdict pass={DEMO_RUN.verdict.pass} /> {DEMO_RUN.verdict.passed}/{facts.policyPuzzles} · {DEMO_RUN.verdict.decidedAt.slice(0, 10)}</p>
          <p className="cdm-note">Signed result attached · anyone can verify it offline</p>
        </div>
      </div>
    </BrowserFrame>
  );
}

/** The mockup a beat names, with the beat's alt text as its accessible description. */
export function beatVisual(beat: LaunchBeat, theme?: MockupTheme): ReactElement {
  const visual = beat.visual;
  if (visual.kind !== "mockup") throw new RangeError(`Beat ${beat.id} has no mockup visual.`);
  const describe = beat.alt;
  const state = visual.state as Record<string, string>;
  switch (visual.id) {
    case "try-run": return <TryRun describe={describe} run={state.run as TryRunState} theme={theme} />;
    case "score-split": return <ScoreSplit describe={describe} theme={theme} />;
    case "puzzle": return <Puzzle describe={describe} theme={theme} />;
    case "result": return <Result describe={describe} theme={theme} view={state.view as ResultView} />;
    case "verify": return <Verify describe={describe} file={state.file as VerifyFile} theme={theme} />;
    case "listing": return <Listing describe={describe} theme={theme} />;
    default: throw new RangeError(`Unknown Clankdar mockup "${visual.id}".`);
  }
}

export function renderMockupHtml(element: ReactElement): string {
  return renderToStaticMarkup(element);
}
