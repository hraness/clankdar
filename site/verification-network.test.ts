import { expect, test } from "bun:test";
import { classifyVerificationRequest } from "./verification-network";

const origin = "https://clankdar.com";

test("retains first-party navigation and local verification", () => {
  expect(classifyVerificationRequest(`${origin}/docs/?example=1`, "GET", origin)).toBe("first-party");
  expect(classifyVerificationRequest("http://localhost:3000/analytics.js", "GET", "http://localhost:3000")).toBe("first-party");
});

test("recognizes only the declared consent-region read", () => {
  expect(classifyVerificationRequest("https://account.hraness.com/api/consent/region", "GET", origin)).toBe("consent-region");
});

test.each([
  ["https://account.hraness.com/api/consent/region", "POST"],
  ["https://account.hraness.com/api/consent/region?unexpected=1", "GET"],
  ["https://account.hraness.com/api/consent/region/", "GET"],
  ["http://account.hraness.com/api/consent/region", "GET"],
  ["https://account.hraness.com.attacker.test/api/consent/region", "GET"],
  ["https://user:password@account.hraness.com/api/consent/region", "GET"],
  ["https://us.i.posthog.com/i/v0/e/", "POST"],
  ["https://us-assets.i.posthog.com/static/array.js", "GET"],
  ["not a URL", "GET"],
])("blocks undeclared traffic: %s %s", (url, method) => {
  expect(classifyVerificationRequest(url, method, origin)).toBe("blocked");
});
