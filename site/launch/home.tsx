/**
 * The two homepage mockups, rendered once at build time into index.html's
 * {{MOCKUP_*}} slots. They are the same components the launch post and film use.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { ScoreSplit, Verify } from "./mockups.tsx";

function figure(body: string, caption: string): string {
  return `<figure class="launch-mockup">${body}<figcaption>${caption}</figcaption></figure>`;
}

export function renderHomeMockups(): Record<`{{MOCKUP_${string}}}`, string> {
  return {
    "{{MOCKUP_EXACT}}": figure(
      renderToStaticMarkup(<ScoreSplit describe="One puzzle scored twice: the computed answer passes and a reply one lower fails." />),
      "Each reply is right or wrong; no model grades it.",
    ),
    "{{MOCKUP_TAMPER}}": figure(
      renderToStaticMarkup(<Verify describe="A terminal verifies a result after one answer was edited, and the verifier rejects it." file="tampered" />),
      "Change one answer and the signature no longer matches.",
    ),
  };
}
