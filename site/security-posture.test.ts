import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("security.txt names a reporting route and has not expired", () => {
  const text = read("./well-known/security.txt");
  expect(text).toContain("Contact: https://github.com/hraness/clankdar/security/advisories/new");
  const expires = /^Expires: (.+)$/m.exec(text)?.[1];
  expect(expires).toBeDefined();
  expect(Date.parse(expires as string)).toBeGreaterThan(Date.now());
});

test("every response carries the baseline security headers", () => {
  const config = JSON.parse(read("../vercel.json")) as { headers: { headers: { key: string; value: string }[] }[] };
  const headers = Object.fromEntries(config.headers[0]!.headers.map(h => [h.key, h.value]));
  expect(headers["Strict-Transport-Security"]).toContain("max-age=63072000");
  expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  expect(headers["Referrer-Policy"]).toBeDefined();
  expect(headers["Permissions-Policy"]).toBeDefined();
});
