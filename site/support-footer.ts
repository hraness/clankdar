import { renderHranessSiteFooter } from "@hraness/site-footer";

export function supportFooter(): string {
  return renderHranessSiteFooter({
    mailingList: { kind: "none" },
  });
}
