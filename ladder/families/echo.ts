import type { Family } from "../family.ts";
import { rng } from "../rng.ts";
import { WORDS } from "./words.ts";

/**
 * Tier 0 floor family: trivially verifiable instruction following.
 * Answers are exact by construction.
 */
export const echo: Family = {
  name: "echo",
  tiers: [0],
  generate(tier, seed) {
    const r = rng(seed);
    const word = r.pick(WORDS);
    const kind = r.int(4);
    let prompt: string, answer: string;
    if (kind === 0) {
      prompt = `Reply with exactly this word and nothing else: ${word}`;
      answer = word;
    } else if (kind === 1) {
      prompt = `Repeat the word "${word}" exactly twice, separated by a single space. Reply with only that.`;
      answer = `${word} ${word}`;
    } else if (kind === 2) {
      prompt = `Write the word "${word}" in ALL CAPITAL LETTERS. Reply with only that.`;
      answer = word.toUpperCase();
    } else {
      prompt = `Write the word "${word}" backwards. Reply with only the reversed word.`;
      answer = [...word].reverse().join("");
    }
    return { family: this.name, tier, seed, prompt, answer };
  },
};
