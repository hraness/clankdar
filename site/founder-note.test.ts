import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = import.meta.dir;
const blurb = "Clankdar checks what your agent can actually solve. Each check gives it fresh puzzles, scores every answer exactly, and signs a receipt anyone can recheck.";

test("the home page leads with the founder note directly below the hero", () => {
  const html = readFileSync(resolve(root, "index.html"), "utf8");
  const hero = html.indexOf("data-hraness-hero");
  const note = html.indexOf('class="founder-note"');
  const next = html.indexOf('id="how"');
  expect(hero).toBeGreaterThan(-1);
  expect(note).toBeGreaterThan(hero);
  expect(note).toBeLessThan(next);
  expect(html).toContain(`<p>${blurb}</p>`);
  expect(html).toContain('href="https://clankdar.com"');
  expect(html).toContain('class="founder-note__signature">Ben Guo');
});

test("the README blockquote carries the same blurb", () => {
  const readme = readFileSync(resolve(root, "../README.md"), "utf8");
  const quote = readme.split("\n").filter((line) => line.startsWith(">")).map((line) => line.replace(/^>\s?/, "")).join(" ");
  expect(quote).toContain(`📡 ${blurb}`);
});
