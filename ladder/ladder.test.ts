import { describe, expect, test } from "bun:test";
import { FAMILIES, normalize, answersMatch, answerFormat, type Instance } from "./mod.ts";
import { _internals as crypt } from "./families/cryptarithm.ts";
import { integerCandidates, wordCandidates } from "./families/hiddenfn.ts";
import { gridCandidates, transformGrid } from "./families/gridxf.ts";

const SEEDS = [...Array.from({ length: 33 }, (_, i) => i), 42, 112, 9001, 0xffffffff];

// --- shared helpers: re-derive the answer from the prompt text -------------

function evalExpr(src: string): number {
  let i = 0;
  const peek = () => src[i];
  const skip = () => { while (src[i] === " ") i++; };
  function expr(): number {
    let v = term();
    while (true) {
      skip();
      if (peek() === "+") { i++; v += term(); }
      else if (peek() === "-") { i++; v -= term(); }
      else return v;
    }
  }
  function term(): number {
    let v = factor();
    while (true) {
      skip();
      if (peek() === "*") { i++; v *= factor(); }
      else if (peek() === "/") { i++; const d = factor(); v = v / d; }
      else return v;
    }
  }
  function factor(): number {
    skip();
    if (peek() === "(") { i++; const v = expr(); skip(); i++; return v; }
    if (peek() === "-") { i++; return -factor(); }
    let s = "";
    while (/[0-9]/.test(peek() ?? "")) s += src[i++];
    return Number(s);
  }
  return expr();
}

function caStep(row: number[], rule: number): number[] {
  const w = row.length;
  return row.map((_, i) => {
    const l = i > 0 ? row[i - 1] : 0, rt = i < w - 1 ? row[i + 1] : 0;
    return (rule >> ((l << 2) | (row[i] << 1) | rt)) & 1;
  });
}

// --- per-family validators: true iff `answer` is the right answer to `prompt`

const validators: Record<string, (inst: Instance) => boolean> = {
  echo: ({ prompt, answer }) => {
    const m = prompt.match(/this word and nothing else: (\w+)/);
    if (m) return answer === m[1];
    const d = prompt.match(/Repeat the word "(\w+)" exactly twice/);
    if (d) return answer === `${d[1]} ${d[1]}`;
    const caps = prompt.match(/Write the word "(\w+)" in ALL CAPITAL/);
    if (caps) return answer === caps[1].toUpperCase();
    const back = prompt.match(/Write the word "(\w+)" backwards/);
    if (back) return answer === [...back[1]].reverse().join("");
    return false;
  },

  arithmetic: ({ prompt, answer }) => {
    const m = prompt.match(/What is (\d+) \+ (\d+)\?/);
    if (m) return answer === String(Number(m[1]) + Number(m[2]));
    const e = prompt.match(/Compute (.+)\. Work left/);
    if (e) return Number(answer) === evalExpr(e[1]);
    return false;
  },

  strings: ({ prompt, answer }) => {
    const idx = prompt.match(/(\d+)(?:nd|rd|th) letter of the word "(\w+)"/);
    if (idx) return answer === idx[2][Number(idx[1]) - 1];
    const cnt = prompt.match(/letter "(\w)" appear in the word "(\w+)"/);
    if (cnt) return answer === String([...cnt[2]].filter((c) => c === cnt[1]).length);
    const dbl = prompt.match(/Write "(\w+)" with every letter doubled/);
    if (dbl) return answer === [...dbl[1]].map((c) => c + c).join("");
    const dev = prompt.match(/vowels \(a, e, i, o, u\) from the word "(\w+)"/);
    if (dev) return answer === [...dev[1]].filter((c) => !"aeiou".includes(c)).join("");
    const il = prompt.match(/Interleave the letters of "(\w+)" and "(\w+)"/);
    if (il) {
      let out = "";
      for (let i = 0; i < Math.min(il[1].length, il[2].length); i++) out += il[1][i] + il[2][i];
      return answer === out;
    }
    const half = prompt.match(/first half of "(\w+)" and the second half of "(\w+)"/);
    if (half)
      return answer === half[1].slice(0, Math.floor(half[1].length / 2)) + half[2].slice(Math.floor(half[2].length / 2));
    return false;
  },

  sequence: ({ prompt, answer }) => {
    const nums = prompt.match(/sequence\? ([-\d, ]+), \?/);
    if (!nums) return false;
    const terms = nums[1].split(",").map(Number);
    if (terms.length !== 5) return false;
    const [a, b, c, d, e] = terms;
    const candidates = [
      b - a === c - b && c - b === d - c && d - c === e - d ? e + e - d : null,
      a !== 0 && b / a === c / b && c / b === d / c && d / c === e / d ? e * b / a : null,
      c === a + b && d === b + c && e === c + d ? d + e : null,
      b - a === 3 && c - b === 5 && d - c === 7 && e - d === 9 ? e + 11 : null,
    ].filter((value) => value !== null);
    return candidates.length > 0 && candidates.every((value) => value === Number(answer));
  },

  cipher: ({ prompt, answer }) => {
    const m = prompt.match(/The text "(\w+)" .* forward by (\d+)/);
    if (!m) return false;
    const dec = [...m[1]]
      .map((c) => String.fromCharCode(((c.charCodeAt(0) - 97 - Number(m[2]) + 2600) % 26) + 97))
      .join("");
    return dec === answer;
  },

  ordering: ({ prompt, answer }) => {
    const names = Object.fromEntries([...prompt.matchAll(/([A-D])=(\w+)/g)].map((m) => [m[1], m[2]]));
    const letters = Object.keys(names);
    const clues = [...prompt.matchAll(/(\w+) finished before (\w+)/g)].map((m) => [m[1], m[2]]);
    const permute = function* (xs: string[]): Generator<string[]> {
      if (xs.length <= 1) { yield xs; return; }
      for (let i = 0; i < xs.length; i++)
        for (const p of permute(xs.slice(0, i).concat(xs.slice(i + 1)))) yield [xs[i], ...p];
    };
    let sols: string[][] = [];
    for (const p of permute(letters)) {
      const pos = new Map(p.map((l, i) => [l, i]));
      if (clues.every(([a, b]) => pos.get(Object.keys(names).find((k) => names[k] === a)!)! <
        pos.get(Object.keys(names).find((k) => names[k] === b)!)!)) sols.push(p);
    }
    return sols.length === 1 && sols[0].join(" ") === answer;
  },

  gridpath: ({ prompt, answer }) => {
    const block = prompt.split("\n\n")[1];
    const grid = block.split("\n").map((l) => l.split(""));
    const h = grid.length, w = grid[0].length;
    const dist = Array.from({ length: h }, () => Array<number>(w).fill(-1));
    dist[0][0] = 0;
    const q: [number, number][] = [[0, 0]];
    while (q.length) {
      const [x, y] = q.shift()!;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && grid[ny][nx] !== "#" && dist[ny][nx] < 0) {
          dist[ny][nx] = dist[y][x] + 1;
          q.push([nx, ny]);
        }
      }
    }
    return dist[h - 1][w - 1] === Number(answer);
  },

  knights: ({ prompt, answer }) => {
    const n = (answer.match(/=/g) ?? []).length;
    const C = (l: string) => l.charCodeAt(0) - 65;
    const parseClaim = (t: string): ((a: boolean[]) => boolean) | null => {
      const simple = t.match(/^([A-D]) is a (knight|knave)$/);
      if (simple) return (a) => a[C(simple[1])] === (simple[2] === "knight");
      const both = t.match(/^([A-D]) and ([A-D]) are both (knight|knave)s$/);
      if (both) return (a) => a[C(both[1])] === (both[3] === "knight") && a[C(both[2])] === (both[3] === "knight");
      const either = t.match(/^at least one of ([A-D]) and ([A-D]) is a (knight|knave)$/);
      if (either) return (a) => a[C(either[1])] === (either[3] === "knight") || a[C(either[2])] === (either[3] === "knight");
      const one = t.match(/^exactly one of ([A-D]) and ([A-D]) is a knight$/);
      if (one) return (a) => a[C(one[1])] !== a[C(one[2])];
      const count = t.match(/^exactly (\d+) of us tell the truth$/);
      if (count) return (a) => a.filter(Boolean).length === Number(count[1]);
      return null;
    };
    const stmts = [...prompt.matchAll(/([A-D]) says: "([^"]+)"/g)]
      .map((m) => ({ s: C(m[1]), pred: parseClaim(m[2].replace(/\.$/, "")) }));
    if (stmts.some((s) => !s.pred)) return false;
    const sols: number[] = [];
    for (let mask = 0; mask < 1 << n; mask++) {
      const a = Array.from({ length: n }, (_, i) => Boolean(mask & (1 << i)));
      if (stmts.every(({ s, pred }) => a[s] === pred!(a))) sols.push(mask);
    }
    if (sols.length !== 1) return false;
    const expect = Array.from({ length: n }, (_, i) => `${String.fromCharCode(65 + i)}=${sols[0] & (1 << i) ? "knight" : "knave"}`).join(" ");
    return answer === expect;
  },

  registervm: ({ prompt, answer }) => {
    const listing = prompt.split("\n\n")[1];
    const regs = [0, 0, 0];
    for (const line of listing.split("\n")) {
      const m = line.match(/^\d+: (\w+) r(\d) (r\d|\d+)$/);
      if (!m) return false;
      const [, op, a, b] = m;
      const i = Number(a);
      const vb = b.startsWith("r") ? regs[Number(b[1])] : Number(b);
      const v = op === "mov" ? vb
        : op === "add" ? regs[i] + vb
        : op === "sub" ? regs[i] - vb
        : op === "mul" ? regs[i] * vb
        : op === "xor" ? regs[i] ^ vb
        : regs[i] << vb;
      regs[i] = v & 0xffff;
    }
    return regs[0] === Number(answer);
  },

  sudoku: ({ prompt, answer }) => {
    const block = prompt.split("\n\n")[1];
    const clue = block.split("\n").map((l) => l.split(" ").map((c) => (c === "." ? 0 : Number(c))));
    const n = clue.length;
    const sol = answer.split(" / ").map((r) => r.split(" ").map(Number));
    if (sol.length !== n || sol.some((r) => r.length !== n)) return false;
    const bw = n === 6 ? 3 : n === 4 ? 2 : 3;
    const bh = n === 6 ? 2 : n === 4 ? 2 : 3;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        if (clue[y][x] !== 0 && clue[y][x] !== sol[y][x]) return false;
        const v = sol[y][x];
        if (v < 1 || v > n) return false;
      }
    const ok = (arr: number[]) => new Set(arr).size === n;
    for (let i = 0; i < n; i++) {
      if (!ok(sol[i]) || !ok(sol.map((r) => r[i]))) return false;
    }
    for (let by = 0; by < n; by += bh)
      for (let bx = 0; bx < n; bx += bw)
        if (!ok(Array.from({ length: bh }, (_, dy) => sol[by + dy].slice(bx, bx + bw)).flat())) return false;
    return true;
  },

  cryptarithm: ({ prompt, answer }) => {
    const m = prompt.match(/addition ([A-Z]+) \+ ([A-Z]+) = ([A-Z]+)\. What number does ([A-Z]+) equal/);
    if (!m) return false;
    const [, w1, w2, w3, asked] = m;
    if (asked !== w3) return false;
    if (crypt.countSolutions(w1, w2, w3, 2) !== 1) return false;
    const sol = crypt.firstSolution(w1, w2, w3);
    if (!sol) return false;
    const val = (w: string) => Number([...w].map((c) => sol.get(c)).join(""));
    return val(w1) + val(w2) === val(w3) && String(val(w3)) === answer;
  },

  automata: ({ prompt, answer }) => {
    const m = prompt.match(/rule (\d+):[\s\S]*?\n\n([01]+)\n\nAfter exactly (\d+) steps/);
    if (!m) return false;
    const rule = Number(m[1]);
    let row = [...m[2]].map(Number);
    for (let i = 0; i < Number(m[3]); i++) row = caStep(row, rule);
    return row.join("") === answer;
  },

  hiddenfn: ({ prompt, tier, answer }) => {
    const examples = [...prompt.matchAll(/f\(([^)]+)\) = ([a-z0-9-]+)/g)].map((m) => [m[1], m[2]]);
    const query = prompt.match(/f\(([^)]+)\) = \?/);
    if (!query || examples.length < 4 || examples.some(([input]) => input === query[1])) return false;
    const rules = prompt.includes("each word")
      ? wordCandidates()
      : integerCandidates(tier).map((rule) => (x: string) => String(rule(Number(x))));
    const remaining = rules.filter((rule) => examples.every(([input, output]) => rule(input) === output));
    return remaining.length > 0 && remaining.every((rule) => rule(query[1]) === answer);
  },
  gridxf: ({ prompt, tier, answer }) => {
    const parse = (grid: string) => grid.trim().split("\n").map((row) => row.trim().split(" ").map(Number));
    const pairs = [...prompt.matchAll(/Example \d+ input:\n([\d \n]+)\nExample \d+ output:\n([\d \n]+)/g)].map((m) => [parse(m[1]), parse(m[2])]);
    const query = prompt.match(/same rule to this input:\n([\d \n]+)\n\nReply/);
    if (!query || pairs.length < 2) return false;
    const remaining = gridCandidates(tier).filter((rule) => pairs.every(([input, output]) => JSON.stringify(rule(input)) === JSON.stringify(output)));
    return remaining.length > 0 && remaining.every((rule) => JSON.stringify(rule(parse(query[1]))) === JSON.stringify(parse(answer)));
  },
};

// --- suite ------------------------------------------------------------------

describe("ladder suite", () => {
  test("spatial primitives follow the advertised operations without mutating input", () => {
    const grid = [[1, 2, 0], [3, 0, 4]];
    expect(transformGrid("rot90", grid)).toEqual([[3, 1], [0, 2], [4, 0]]);
    expect(transformGrid("rot180", grid)).toEqual([[4, 0, 3], [0, 2, 1]]);
    expect(transformGrid("flipH", grid)).toEqual([[3, 0, 4], [1, 2, 0]]);
    expect(transformGrid("flipV", grid)).toEqual([[0, 2, 1], [4, 0, 3]]);
    expect(transformGrid("transpose", grid)).toEqual([[1, 3], [2, 0], [0, 4]]);
    expect(transformGrid("gravity", grid)).toEqual([[1, 0, 0], [3, 2, 4]]);
    expect(transformGrid("crop", [[0, 0, 0], [0, 3, 0]])).toEqual([[3]]);
    expect(transformGrid("crop", [[0, 0]])).toEqual([[0]]);
    expect(grid).toEqual([[1, 2, 0], [3, 0, 4]]);
  });

  for (const family of FAMILIES) {
    for (const tier of family.tiers) {
      test(`${family.name} t${tier}: deterministic and answers verify`, () => {
        for (const seed of SEEDS) {
          const a = family.generate(tier, seed);
          const b = family.generate(tier, seed);
          expect(a.prompt).toBe(b.prompt);
          expect(a.answer).toBe(b.answer);
          expect(a.prompt.length).toBeGreaterThan(10);
          expect(a.answer.length).toBeGreaterThan(0);
          const v = validators[family.name];
          expect(v).toBeDefined();
          expect(v(a)).toBe(true);
          expect(v({ ...a, answer: "definitely not the answer" })).toBe(false);
          expect(answersMatch(a.answer, a.answer, answerFormat(a.family))).toBe(true);
        }
      });
    }
  }

  test("distinct seeds produce distinct prompts", () => {
    for (const family of FAMILIES) {
      const tier = family.tiers[0];
      const prompts = new Set([1, 2, 3, 4, 5].map((s) => family.generate(tier, s).prompt));
      expect(prompts.size).toBeGreaterThan(1);
    }
  });

  test("normalization is format-insensitive", () => {
    expect(normalize("  4 1 3 2 / 2 4 1 3 ")).toBe("4 1 3 2 / 2 4 1 3");
    expect(answersMatch("A=Knight B=Knave", "a = knight, b = knave", "assignments")).toBe(true);
    expect(answersMatch("123", "1234")).toBe(false);
  });
});
