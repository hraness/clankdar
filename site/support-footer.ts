import { renderHranessSiteFooter } from "@hraness/site-footer";

export function supportFooter(): string {
  return renderHranessSiteFooter({
    placement: "flow",
    mailingList: { kind: "none" },
  });
}
