/**
 * The body of "Introducing Clankdar": the launch film (once rendered), the
 * beats with their mockups, "Go deeper" links, and the social kit. The short
 * lede and the full hosted limits are built here from the same facts.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { LaunchBeats, SocialKitPanel } from "@hraness/design-kit/react";
import { LAUNCH_BEATS, LAUNCH_SOCIAL_KIT } from "./beats.ts";
import { beatVisual } from "./mockups.tsx";
import { LAUNCH_FACTS } from "./facts.ts";

const f = (key: keyof typeof LAUNCH_FACTS) => LAUNCH_FACTS[key].value;

/** Where a reader goes next, named for the task. */
export const GO_DEEPER: readonly { href: string; label: string }[] = Object.freeze([
  { href: "/#try", label: "Solve a practice puzzle in your browser" },
  { href: "/docs/#own-solver", label: "Connect your own agent to the local check" },
  { href: "/docs/#verification", label: "Verify a signed result yourself" },
  { href: "/docs/#integrate", label: "Add a check to your app" },
  { href: "/blog/how-clankdar-uses-algal", label: "See how each answer is computed" },
  { href: "/docs/#security", label: "Understand what a check establishes" },
]);

/** The launch film, built in video/story (story.config.ts) and delivered to site/media. */
export const LAUNCH_FILM = Object.freeze({
  mp4: "/media/clankdar-launch.mp4",
  poster: "/media/clankdar-launch-poster.jpg",
  captions: "/media/clankdar-launch.vtt",
  width: 1920,
  height: 1080,
  description: "A 33-second film with captions and no narration: claims about agents without the test, a fresh puzzle whose near miss fails, the default check's numbers, a signed result that breaks when one answer changes, and what a pass doesn't prove.",
});

const siteRoot = resolve(import.meta.dir, "..");

/** True only when every film file is in site/media; the post never embeds a missing file. */
export function filmDelivered(): boolean {
  return [LAUNCH_FILM.mp4, LAUNCH_FILM.poster, LAUNCH_FILM.captions].every(path => existsSync(resolve(siteRoot, path.slice(1))));
}

function Film() {
  return (
    <figure className="plain-publication__figure" data-figure-kind="video" data-width="text">
      <div className="plain-publication__figure-body">
        <video controls height={LAUNCH_FILM.height} playsInline poster={LAUNCH_FILM.poster} preload="metadata" width={LAUNCH_FILM.width} aria-label={LAUNCH_FILM.description}>
          <source src={LAUNCH_FILM.mp4} type="video/mp4" />
          <track default kind="captions" label="English" src={LAUNCH_FILM.captions} srcLang="en" />
        </video>
      </div>
    </figure>
  );
}

export function renderLaunchBodyHtml(): string {
  return renderToStaticMarkup(
    <>
      <p>Use Clankdar to record what an agent solved before you offer it work or compare it with another version. Each check produces a signed result that you can save and verify offline.</p>
      {filmDelivered() ? <Film /> : null}
      <LaunchBeats beats={LAUNCH_BEATS} renderVisual={beat => beatVisual(beat)} />
      <p>Hosted staging allows {f("stagingTotal")} issued checks over its lifetime and {f("stagingPerMinute")} per fixed UTC minute across the whole service, and the first accepted submission fixes the result, including a failed one.</p>
      <h2 id="go-deeper">Run and verify a check</h2>
      <ul>
        {GO_DEEPER.map(link => <li key={link.href}><a href={link.href}>{link.label}</a></li>)}
      </ul>
      <SocialKitPanel kit={LAUNCH_SOCIAL_KIT} />
    </>,
  );
}
