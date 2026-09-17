import { expect, test } from "bun:test";
import { supportFooter } from "./support-footer.ts";

test("renders the canonical footer without a newsletter form or client runtime", () => {
  const html = supportFooter();
  expect(html).toContain('id="hraness-site-footer"');
  expect(html).toContain('data-mailing-list="none"');
  expect(html).not.toContain("<form");
  expect(html).not.toContain("<input");
  expect(html).not.toContain("<script");
});
