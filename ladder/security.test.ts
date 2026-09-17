import { describe, expect, test } from "bun:test";
import { answersMatch } from "./family.ts";
import { answerCommitment, verifyAnswer } from "./commit.ts";
import { rng } from "./rng.ts";
import { gridpath } from "./families/gridpath.ts";
import { sequence } from "./families/sequence.ts";

const key = new Uint8Array(32).fill(7);

describe("scoring integrity", () => {
  test("signs, punctuation, token boundaries, and case are meaningful", () => {
    for (const [expected, response] of [["-5", "5"], ["1.5", "15"], ["1 23", "12 3"], ["WORD", "word"], ["0", ""], ["a", "a!"]]) {
      expect(answersMatch(expected, response)).toBe(false);
    }
  });

  test("empty answers do not pass", () => {
    expect(answersMatch("", "")).toBe(false);
    expect(answersMatch(" ", "\n")).toBe(false);
  });
});

describe("answer commitments", () => {
  test("a verifier key is mandatory", () => {
    expect(() => Reflect.apply(answerCommitment, null, ["challenge", "4"])).toThrow();
  });

  test("transcript fields are unambiguous", () => {
    expect(answerCommitment("a", "bc", key)).not.toBe(answerCommitment("ab", "c", key));
  });

  test("keys and challenge IDs bind the commitment", () => {
    const commitment = answerCommitment("challenge", "4", key);
    expect(verifyAnswer("challenge", commitment, "4", key)).toBe(true);
    expect(verifyAnswer("challenge", commitment, "4", new Uint8Array(32).fill(8))).toBe(false);
    expect(verifyAnswer("other", commitment, "4", key)).toBe(false);
    expect(verifyAnswer("challenge", commitment, "-4", key)).toBe(false);
    expect(verifyAnswer("challenge", "not-a-digest", "4", key)).toBe(false);
  });
});

describe("generator integrity", () => {
  test("seeds cannot silently alias through uint32 coercion", () => {
    for (const seed of [-1, 2 ** 32, 1.5, NaN, Infinity]) expect(() => rng(seed)).toThrow();
    expect(rng(0).next()).not.toBe(rng(0x9e3779b9).next());
  });

  test("path answers vary instead of always equaling Manhattan distance", () => {
    const answers = new Set(Array.from({ length: 64 }, (_, seed) => gridpath.generate(3, seed).answer));
    expect(answers.size).toBeGreaterThan(1);
    expect([...answers].every((answer) => Number(answer) > 10)).toBe(true);
  });

  test("every sequence presents five terms and a valid continuation", () => {
    for (let seed = 0; seed < 64; seed++) {
      const instance = sequence.generate(2, seed);
      const terms = instance.prompt.match(/sequence\? ([-\d, ]+), \?/)![1].split(",").map(Number);
      expect(terms).toHaveLength(5);
      const [a, b, c, d, e] = terms;
      const candidates = [
        b - a === c - b && c - b === d - c && d - c === e - d ? e + (e - d) : null,
        a !== 0 && b / a === c / b && c / b === d / c && d / c === e / d ? e * (b / a) : null,
        c === a + b && d === b + c && e === c + d ? d + e : null,
        b - a === 3 && c - b === 5 && d - c === 7 && e - d === 9 ? e + 11 : null,
      ].filter((value) => value !== null);
      expect(new Set(candidates)).toEqual(new Set([Number(instance.answer)]));
    }
  });
});
