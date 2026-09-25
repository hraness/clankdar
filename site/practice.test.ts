import { describe, expect, test } from "bun:test";
import { practicePuzzles, renderPractice } from "./practice-data.ts";
import { algalWorkedExample, solveAlgalPuzzle } from "../ladder/families/algal.ts";
import { scoreAnswer } from "../ladder/family.ts";

describe("instant public practice", () => {
  test("every offered answer is scored against official ALGAL execution", () => {
    const example = algalWorkedExample();
    for (const puzzle of practicePuzzles()) {
      expect(puzzle.answer).toBe(solveAlgalPuzzle({ ...example, inputs: { values: puzzle.values } }).answer);
      expect(puzzle.choices.filter(answer => scoreAnswer(puzzle.answer, answer, "integer").pass)).toHaveLength(1);
      expect(new Set(puzzle.choices).size).toBe(3);
    }
  });
  test("the first example stays usable without scripts and never represents a receipt", () => {
    const html = renderPractice();
    expect(html).toContain('data-practice-controls hidden');
    expect(html).toContain('data-practice-solution>34</code>');
    expect(html).toContain('No receipt is issued');
    expect(html).not.toMatch(/<form\b|<script\b|\sonclick=/);
  });
});
