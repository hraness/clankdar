import type { Family } from "../family.ts";
import { rng } from "../rng.ts";
import { WORDS } from "./words.ts";

/** Tiers 1-2: precise string surgery. */
export const strings: Family = {
  name: "strings",
  tiers: [1, 2],
  generate(tier, seed) {
    const r = rng(seed);
    const word = r.pick(WORDS);
    const kind = tier === 1 ? r.pick([0, 1, 2]) : r.pick([3, 4, 5]);
    let prompt: string, answer: string;
    if (kind === 0) {
      const i = r.intBetween(2, Math.min(6, word.length));
      prompt = `What is the ${i}${i === 2 ? "nd" : i === 3 ? "rd" : "th"} letter of the word "${word}"? (Counting from 1.) Reply with only the letter.`;
      answer = word[i - 1];
    } else if (kind === 1) {
      const letter = r.pick([...new Set(word)]);
      prompt = `How many times does the letter "${letter}" appear in the word "${word}"? Reply with only the number.`;
      answer = String([...word].filter((c) => c === letter).length);
    } else if (kind === 2) {
      prompt = `Write "${word}" with every letter doubled (e.g. "ab" becomes "aabb"). Reply with only the result.`;
      answer = [...word].map((c) => c + c).join("");
    } else if (kind === 3) {
      prompt = `Remove all vowels (a, e, i, o, u) from the word "${word}". Reply with only the remaining letters in order.`;
      answer = [...word].filter((c) => !"aeiou".includes(c)).join("");
    } else if (kind === 4) {
      const w2 = r.pick(WORDS.filter((w) => w !== word));
      prompt = `Interleave the letters of "${word}" and "${w2}" starting with the first letter of "${word}" (stop when either runs out). Reply with only the result.`;
      const n = Math.min(word.length, w2.length);
      let out = "";
      for (let i = 0; i < n; i++) out += word[i] + w2[i];
      answer = out;
    } else {
      const w2 = r.pick(WORDS.filter((w) => w !== word));
      prompt = `Take the first half of "${word}" and the second half of "${w2}", then join them. (Odd lengths: first half rounds down, second half rounds up.) Reply with only the result.`;
      answer = word.slice(0, Math.floor(word.length / 2)) + w2.slice(Math.floor(w2.length / 2));
    }
    return { family: this.name, tier, seed, prompt, answer };
  },
};
