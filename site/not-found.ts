import { renderStatusPageHtml, type StatusPageLink } from "@hraness/design-kit";
import { marketing } from "./portfolio-copy";

/** Pages the sitemap lists, with a label for "Did you mean". */
export const STATIC_PAGES: readonly StatusPageLink[] = [
  { href: "/", label: marketing.names.name },
  { href: "/docs/", label: "Docs" },
  { href: "/benchmark/", label: "Model benchmark" },
];

/** Status page labels hold at most 48 characters; long post titles end in an ellipsis. */
export function routeLabel(title: string): string {
  return title.length <= 48 ? title : `${title.slice(0, 47).trimEnd()}…`;
}

/** The shared status page for missing addresses. The primary action matches the homepage hero. */
export function renderNotFound(routes: readonly StatusPageLink[]): string {
  return renderStatusPageHtml({
    siteName: marketing.names.name,
    rootElement: "div",
    primaryAction: { href: "/docs/#quickstart", label: marketing.hero.primaryAction },
    next: [
      { href: "/", label: `How ${marketing.names.name} works`, description: marketing.short },
      { href: "/docs/#verification", label: "Verify a receipt", description: "Check the signature and rescore the recorded answers with the issuer’s public key." },
      { href: "/benchmark/", label: "Model benchmark", description: "Recorded model scores, test conditions, and downloadable evidence." },
    ],
    routes,
    agentIndexHref: "/llms.txt",
  });
}
