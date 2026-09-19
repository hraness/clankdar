/**
 * Server-side JavaScript integration example (Node 22+ or Bun).
 * You supply solve(challenges, signal); this file selects no model and spends
 * no inference budget itself. Keep the invitation token on your server.
 * Verify the returned receipt before admitting work. This minimal helper keeps
 * state in memory. Awaited onIssued(record) saves the private ticket before
 * solving; checkpoint(record) saves the ticket and answers before submission.
 * Keep both records private. Resume interrupted solving from the issued record;
 * retry submission with its saved ticket and answers, never a replacement check.
 * Forward signal to your solver transport to stop provider work at the deadline.
 *
 * const result = await check({
 *   baseUrl: "https://clankdar-hosted-staging.972abc65.workers.dev",
 *   token: process.env.CLANKDAR_TOKEN, context: "my-room:request-123",
 *   onIssued: record => privateStore.saveIssued(record),
 *   checkpoint: record => privateStore.saveSubmission(record),
 *   solve: async (challenges, signal) => yourSolver(challenges, { signal }),
 * });
 */
export async function check({ baseUrl, token, context, policyId = "algal-floor-v1", solve, onIssued, checkpoint, fetch: fetchImpl = globalThis.fetch }) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/" || (base.protocol !== "https:" && !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)))) throw new Error("baseUrl must be an HTTPS origin or loopback HTTP origin");
  if (typeof token !== "string" || !token || token.length > 4096 || /\s/.test(token)) throw new Error("an invitation token is required");
  if (typeof solve !== "function") throw new Error("provide solve(challenges, signal); no solver is selected by default");
  if (context !== undefined && (typeof context !== "string" || !context.trim() || context.length > 256)) throw new Error("context must be a nonempty string up to 256 characters");
  if (onIssued !== undefined && typeof onIssued !== "function") throw new Error("onIssued must be an async function when supplied");
  if (checkpoint !== undefined && typeof checkpoint !== "function") throw new Error("checkpoint must be an async function when supplied");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(policyId)) throw new Error("policyId is malformed");

  async function request(path, body, authenticated = false) {
    const res = await fetchImpl(`${base.origin}${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`Clankdar request failed (${res.status})`); }
    const reader = res.body?.getReader();
    if (!reader) throw new Error("empty Clankdar response");
    const chunks = []; let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1_048_576) { await reader.cancel(); throw new Error("Clankdar response is too large"); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const result = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder("utf-8", { fatal: true }).decode(result);
  }

  const issued = JSON.parse(await request("/v1/checks", { policyId, ...(context === undefined ? {} : { context }) }, true));
  if (!/^gs_[A-Za-z0-9_-]{12}$/.test(issued.id) || typeof issued.ticket !== "string" || !Array.isArray(issued.challenges) || issued.challenges.length < 1 || issued.challenges.length > 16) throw new Error("invalid issued check");
  const receiptUrl = `${base.origin}/v1/checks/${issued.id}`;
  if (onIssued) await onIssued({ id: issued.id, ticket: issued.ticket, expiresAt: issued.expiresAt, challenges: structuredClone(issued.challenges), receiptUrl });
  // Saving the ticket can take time. Start no solver after that deadline.
  const remaining = Date.parse(issued.expiresAt) - Date.now() - 500;
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 600_000) throw new Error("invalid check deadline");
  const signal = AbortSignal.timeout(remaining);
  let onAbort;
  const aborted = new Promise((_, reject) => { onAbort = () => reject(new Error("solver exceeded the check deadline")); signal.addEventListener("abort", onAbort, { once: true }); });
  let responses;
  try { responses = await Promise.race([Promise.resolve().then(() => solve(issued.challenges, signal)), aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
  const ids = new Set(issued.challenges.map(challenge => challenge.challengeId));
  if (!responses || typeof responses !== "object" || Array.isArray(responses) || Object.entries(responses).some(([id, value]) => !ids.has(id) || typeof value !== "string") || new TextEncoder().encode(JSON.stringify(responses)).length > 120_000) throw new Error("solver must return an object mapping challenge IDs to response strings");
  const submission = { ticket: issued.ticket, responses };
  if (new TextEncoder().encode(JSON.stringify(submission)).length > 131_072) throw new Error("ticket and responses exceed the submission size limit");
  if (checkpoint) await checkpoint({ id: issued.id, ticket: issued.ticket, responses: structuredClone(responses), expiresAt: issued.expiresAt, receiptUrl });
  const decided = JSON.parse(await request(`/v1/checks/${issued.id}/responses`, submission));
  // Download the portable bytes rather than trusting transport pass/score flags.
  const receiptText = await request(`/v1/checks/${issued.id}`);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(receiptText));
  const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (decided.id !== issued.id || decided.sha256 !== sha256) throw new Error("downloaded receipt differs from the submitted decision");
  return { id: issued.id, context, receiptUrl, sha256, receiptText, receipt: JSON.parse(receiptText) };
}
