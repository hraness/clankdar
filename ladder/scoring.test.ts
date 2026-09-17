import { describe, expect, test } from "bun:test";
import { answersMatch, canonicalAnswer, extractFinalAnswer, scoreAnswer, type AnswerFormat } from "./family.ts";

describe("typed answer formats", () => {
  test("integers preserve sign and accept equivalent integer notation only", () => {
    expect(answersMatch("-5", " -005 ", "integer")).toBe(true);
    expect(answersMatch("0", "-0", "integer")).toBe(true);
    for (const wrong of ["5", "-5.0", "-5e0", "-5!", "(-5)", "- 5", "answer: -5"]) {
      expect(answersMatch("-5", wrong, "integer")).toBe(false);
    }
  });

  test("grids preserve dimensions and cell boundaries", () => {
    expect(answersMatch("1 2 / 3 4", "1 2\n3 4", "grid")).toBe(true);
    for (const wrong of ["12 / 34", "1 2 3 4", "1 2\n3", "1 2 / 4 3", "1 2\n3 4\n5 6"]) {
      expect(answersMatch("1 2 / 3 4", wrong, "grid")).toBe(false);
    }
  });

  test("assignments and ordered tokens use a declared grammar", () => {
    expect(answersMatch("A=knight B=knave", "a = KNIGHT, b = knave", "assignments")).toBe(true);
    expect(answersMatch("A=knight B=knave", "B=knave A=knight", "assignments")).toBe(false);
    expect(canonicalAnswer("A=knight A=knight", "assignments")).toBeNull();
    expect(answersMatch("A B C", "a,b,c", "tokens")).toBe(true);
    expect(answersMatch("A B C", "ABC", "tokens")).toBe(false);
  });

  test("binary leading zeroes and text case remain significant", () => {
    expect(answersMatch("001", "1", "bits")).toBe(false);
    expect(answersMatch("HELLO", "hello", "text")).toBe(false);
    expect(answersMatch("hi hi", " hi\nhi ", "text")).toBe(true);
    expect(canonicalAnswer("a\0b")).toBeNull();
    expect(canonicalAnswer("1".repeat(65_537), "integer")).toBeNull();
  });
});

describe("final-answer diagnostic", () => {
  test("extracts an answer block without using the expected answer", () => {
    expect(scoreAnswer("4", "Here is my reasoning.\n\n4", "integer")).toEqual({ pass: false, finalAnswerMatch: true, formatOnly: true });
    expect(extractFinalAnswer("Here is my reasoning.\nFinal answer: **-4**", "integer")).toBe("-4");
    expect(scoreAnswer("-4", "Here is my reasoning.\nFinal answer: **-4**", "integer").finalAnswerMatch).toBe(true);
    expect(scoreAnswer("1 2 / 3 4", "Solved:\n\n```text\n1 2\n3 4\n```", "grid").finalAnswerMatch).toBe(true);
  });

  test("does not match suffixes, prose fragments, or empty error records", () => {
    const cases: [string, string, AnswerFormat][] = [
      ["4", "14", "integer"], ["-4", "4", "integer"], ["4", "Reasoning\n\n14", "integer"],
      ["a", "banana", "text"], ["4", "4\nActually, I am not sure.", "integer"], ["", "", "text"],
      ["1 2", "8 9\n1 2", "grid"], ["4", "This is 4.", "integer"],
    ];
    for (const [expected, response, format] of cases) expect(scoreAnswer(expected, response, format).finalAnswerMatch).toBe(false);
  });
});
