import { scoreAnswer } from "../ladder/family.ts";
import type { PracticePuzzle } from "./practice-data.ts";

const root = document.querySelector<HTMLElement>("[data-practice]");
if (root) {
  const puzzles: PracticePuzzle[] = JSON.parse(root.dataset.practice!);
  const controls = root.querySelector<HTMLFieldSetElement>("[data-practice-controls]")!;
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-practice-answer]")];
  const feedback = root.querySelector<HTMLElement>("[data-practice-feedback]")!;
  const next = root.querySelector<HTMLElement>("[data-practice-next]")!;
  const details = root.querySelector<HTMLDetailsElement>(".answer-reveal")!;
  let index = 0;
  let decided = false;
  controls.hidden = false;
  for (const button of buttons) button.addEventListener("click", () => {
    if (decided) return;
    decided = true;
    const puzzle = puzzles[index];
    const pass = scoreAnswer(puzzle.answer, button.textContent!, "integer").pass;
    for (const choice of buttons) choice.disabled = true;
    button.dataset.selected = "true";
    feedback.textContent = pass ? `Correct — ${puzzle.answer}. The response matches exactly.` : `The response doesn’t match. The answer is ${puzzle.answer}.`;
    next.hidden = false;
  });
  root.querySelector<HTMLButtonElement>("[data-practice-another]")!.addEventListener("click", () => {
    index = (index + 1) % puzzles.length;
    decided = false;
    const puzzle = puzzles[index];
    root.querySelector<HTMLElement>("[data-practice-values]")!.textContent = `values = ${JSON.stringify(puzzle.values)}`;
    root.querySelector<HTMLElement>("[data-practice-solution]")!.textContent = puzzle.answer;
    root.querySelector<HTMLElement>("[data-practice-explanation]")!.textContent = puzzle.explanation;
    buttons.forEach((button, i) => { button.textContent = puzzle.choices[i]; button.disabled = false; delete button.dataset.selected; });
    feedback.textContent = "";
    next.hidden = true;
    details.open = false;
    buttons[0].focus();
  });
}
