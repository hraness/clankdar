/**
 * Pins the film to the launch facts and the post's description of it.
 * Run from video/ after `bun install`: `bun run test`. It is not named *.test.ts
 * so the root `bun test`, which runs without the film dependencies, skips it.
 */
import { expect, test } from "bun:test";
import { LAUNCH_FACTS } from "../../site/launch/facts.ts";
import { LAUNCH_FILM } from "../../site/launch/post.tsx";
import { FILM_COPY } from "./film.tsx";
import { filmTimeline } from "./timeline.ts";

test("proof numbers are the hosted policy from the facts module", () => {
  expect(FILM_COPY.proof.items.map(item => String(item.value))).toEqual([
    LAUNCH_FACTS.policyPuzzles.value,
    LAUNCH_FACTS.policyPasses.value,
    LAUNCH_FACTS.policySeconds.value,
  ]);
});

test("the post describes the film at its real length", () => {
  const seconds = Math.round(filmTimeline(FILM_COPY).duration);
  expect(LAUNCH_FILM.description.startsWith(`A ${seconds}-second film`)).toBe(true);
});

test("the end card keeps the Preview status visible", () => {
  expect(FILM_COPY.end.line.startsWith("Preview.")).toBe(true);
});
