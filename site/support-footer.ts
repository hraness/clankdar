import { renderHranessSiteFooter } from "@hraness/site-footer";

export function supportFooter(): string {
  return renderHranessSiteFooter({
    placement: "sticky",
    mailingList: { kind: "none" },
  });
}
