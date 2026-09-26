import { expect, test } from "bun:test";
import { STATIC_PAGES, renderNotFound, routeLabel } from "./not-found.ts";

test("the 404 page leads with the homepage's primary action", () => {
  const html = renderNotFound(STATIC_PAGES);
  expect(html).toContain('href="/docs/#quickstart">Run a check</a>');
  expect(html.match(/hraness-status-page__next-link/g)).toHaveLength(3);
  expect(html).toContain('href="/llms.txt"');
});

test("long post titles fit the 48-character route label", () => {
  expect(routeLabel("Introducing Clankdar")).toBe("Introducing Clankdar");
  const clipped = routeLabel("How Clankdar uses ALGAL puzzles as an exact referee");
  expect(clipped.length).toBeLessThanOrEqual(48);
  expect(clipped.endsWith("…")).toBe(true);
});
