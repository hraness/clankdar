import type { Family } from "../family.ts";
import { rng } from "../rng.ts";
import { WORDS } from "./words.ts";

function shiftChar(c: string, s: number): string {
  return String.fromCharCode(((c.charCodeAt(0) - 97 + s + 2600) % 26) + 97);
}

/** Tier 2: Caesar-shift decryption. */
export const cipher: Family = {
  name: "cipher",
  tiers: [2],
  generate(tier, seed) {
    const r = rng(seed);
    const word = r.pick(WORDS);
    const s = r.intBetween(1, 25);
    const encrypted = [...word].map((c) => shiftChar(c, s)).join("");
    return {
      family: this.name,
      tier,
      seed,
      prompt: `The text "${encrypted}" was made by shifting every letter of an English word forward by ${s} positions in the alphabet (wrapping z to a). What is the original word? Reply with only the word, lowercase.`,
      answer: word,
    };
  },
};
