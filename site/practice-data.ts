import { algalWorkedExample, solveAlgalPuzzle } from "../ladder/families/algal.ts";
import { scoreAnswer } from "../ladder/family.ts";
import { ALGAL_EXAMPLE_CODE, escapeHtml } from "./content.ts";

export interface PracticePuzzle {
  values: number[];
  answer: string;
  choices: string[];
  explanation: string;
}

/** Public teaching fixtures, executed by the official evaluator during the build. */
export function practicePuzzles(): PracticePuzzle[] {
  const example = algalWorkedExample();
  return [[1, 3, 2, 5], [2, 4, 1, 3], [5, 1, 3, 2], [4, 2, 1, 6], [1, 5, 4, 2], [3, 1, 2, 6]].map((values, index) => {
    const { answer } = solveAlgalPuzzle({ ...example, inputs: { values } });
    const kept = values.filter(value => value > 2);
    const squares = kept.map(value => value * value);
    // Distractors are public practice choices, never inputs to the reference scorer.
    const wrong = [String(Math.max(...squares)), String(kept.reduce((a, b) => a + b, 0))];
    const choices = [...wrong];
    choices.splice(index % 3, 0, answer);
    if (new Set(choices).size !== 3 || choices.filter(choice => scoreAnswer(answer, choice, "integer").pass).length !== 1) throw new Error("practice choices are ambiguous");
    return { values, answer, choices, explanation: `Keep ${kept.join(" and ")}. Square them and add: ${squares.join(" + ")} = ${answer}.` };
  });
}

export function renderPractice(): string {
  const puzzles = practicePuzzles();
  const first = puzzles[0];
  return `<div class="room-heading hraness-material-terminal__bar"><span>Try one puzzle</span><span class="example-label">No signup</span></div>
<div class="sample-body" data-practice="${escapeHtml(JSON.stringify(puzzles))}">
<p class="practice-task">Keep the numbers above 2. Square them, then add.</p>
<p class="practice-input"><code data-practice-values>values = ${escapeHtml(JSON.stringify(first.values))}</code></p>
<fieldset class="practice-choices" data-practice-controls hidden><legend>What is the answer?</legend>${first.choices.map(choice => `<button type="button" data-practice-answer>${escapeHtml(choice)}</button>`).join("")}</fieldset>
<p class="practice-feedback" data-practice-feedback role="status" aria-live="polite" aria-atomic="true"></p>
<div class="practice-next" data-practice-next hidden><a class="primary-link" href="/docs/#quickstart">Run a complete check <span aria-hidden="true">→</span></a><button type="button" data-practice-another>Another puzzle</button></div>
<details class="answer-reveal"><summary>See the Algal code and solution</summary><pre class="code algal-code"><code>${escapeHtml(ALGAL_EXAMPLE_CODE)}</code></pre><code data-practice-solution>${escapeHtml(first.answer)}</code><p data-practice-explanation>${escapeHtml(first.explanation)}</p></details>
<p class="sample-note">Public practice, scored in this page. No receipt is issued. The puzzle is a small program in Algal’s expression language, and each answer comes from running it when the site is built.</p>
</div>`;
}
