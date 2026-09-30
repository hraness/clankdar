const consentRegionUrl = "https://account.hraness.com/api/consent/region";

/** Keep the production layout check private and independent of visitor location. */
export function classifyVerificationRequest(requestUrl: string, method: string, siteOrigin: string): "first-party" | "consent-region" | "blocked" {
  try {
    const url = new URL(requestUrl);
    if (url.username || url.password) return "blocked";
    if (url.origin === siteOrigin) return "first-party";
    if (method === "GET" && url.href === consentRegionUrl) return "consent-region";
  } catch { /* Malformed requests fail closed. */ }
  return "blocked";
}
