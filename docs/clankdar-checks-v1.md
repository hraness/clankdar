# Clankdar check API

The check API issues a fresh set of puzzles, scores the answers you submit,
and returns a signed receipt you can verify offline. Your application handles
scheduling, identity, aggregation, and decisions.

This contract describes an experimental staging service, open by invitation,
at `https://clankdar-hosted-staging.972abc65.workers.dev`. You need no model
provider or Clankdar client library. The
[HTTP quickstart](https://clankdar.com/docs/#hosted) demonstrates the flow.
The [actor and campaign API](clankdar-hosted-v1.md) is a separate, optional
reference application.

## Create one check

`POST /v1/checks` requires `Authorization: Bearer <invitation-token>` and a JSON
object. Keep the token server-side. The invitation token authorizes issuing
checks; it does not identify an agent.

```json
{"policyId":"algal-floor-v1","context":"release-42-preflight"}
```

- `policyId` is optional; the default is `algal-floor-v1`.
- `context` is an optional nonempty application correlation string, up to 256
  characters. It appears in public signed evidence; use an opaque reference,
  never private data or credentials.
- `subjectPublicKey` is an optional canonical base64url Ed25519 public key.
  When supplied, submission must prove possession of that exact key. It does
  not require registration or establish a person, model, or unique agent.

The response contains `ok`, `id`, `ticket`, `policyId`, `expiresAt`,
`challenges`, and a relative `receiptUrl`. Each challenge supplies its actual
`challengeId`, `prompt`, recorded conditions, and issuer key. Answer those
prompts; do not invent challenge IDs. The `gs_…` ID uses the
`clankdar-gate-v1` session identifier format.

The opaque encrypted `ticket` authorizes one submission. Retain it until the
outcome is known and do not log or publish it. An ID alone cannot authorize a
submission. Unanswered tickets expire without storing a result object.

`GET /v1/policies` lists the published policies; `GET /v1/policies/:id` returns
one immutable policy. All three policies ask four puzzles and require three
passing responses. `algal-floor-v1` uses the shared ALGAL expression evaluator
with a 180-second deadline; `v2-floor-v1` allows 120 seconds and
`frontier-floor-v1` allows 180 seconds. A published policy does not change,
and an issued ticket keeps the policy it was issued with. No model scores have
been published for the [ALGAL suite](clankdar-algal-v1.md). Policy names refer
to recorded puzzle conditions, not certified model classes. A create retry issues a fresh check
and consumes another quota slot; it is not an idempotent retry.

## Submit answers once

`POST /v1/checks/:id/responses` accepts:

```json
{
  "ticket":"COPY_THE_ISSUED_TICKET",
  "responses":{"att_ACTUAL_ID":"answer to its prompt"}
}
```

The example shows a shape, not real IDs or valid answers. Include the actual
IDs and your solver's answers. Missing or incorrectly formatted answers do
not pass. An empty object of responses records a failed attempt. A submitted
failure consumes the check just like a success. Invalid credentials, malformed
JSON, unknown challenge IDs, and oversized responses are rejected before
commit; those request errors are not signed failed results.

The ticket is the submission credential; the integrator's invitation token
is not needed on this request. If `subjectPublicKey` was requested, include
`subjectProof: {publicKey, signature}`. Sign the UTF-8 canonical JSON array
`["clankdar/subject/v1", checkId, publicKey]` with that Ed25519 key, then encode
the signature as unpadded base64url. A supplied proof is verified even when
the check did not require one. Key possession does not prove who solved the
puzzles; keys can be shared and work delegated.

A newly committed result returns HTTP 201; recovering an already committed
result returns HTTP 200. The JSON response contains:

```text
ok, id, pass, passed, required, receiptUrl, sha256, receipt
```

`receipt` is the complete signed result, a `clankdar-gate-v1` admission. Its
`payload` is a signed JSON string that holds the challenges, the receipt for
each answered challenge, the policy, the bindings, and the verdict. Checking
an ALGAL receipt needs a checker that recognizes `clankdar-algal-v1` and its
pinned evaluator. The top-level score fields repeat values from the signed
payload for convenience.

The API accepts a result when its create-only R2 write succeeds. Concurrent
submissions cannot replace it. Every later valid retry returns the first
committed result, even if the retry supplies different answers. The API
never returns a locally generated candidate that lost a storage race.

If storage fails before acceptance, keep the ticket and answers and retry
within the original deadline. If a write's outcome is uncertain, the API
first attempts to recover the stored result. A committed result can be
recovered after expiry with its valid ticket, or through the public GET.
There is no background session outbox on this path. An expired, uncommitted
ticket cannot create a new result.

## Retrieve, retain, and verify

`GET /v1/checks/:id` returns the exact canonical JSON admission bytes stored
in R2. It requires no token. A successful response is immutable, carries a
SHA-256 ETag, and can be downloaded or cached. The submission response's
`sha256` hashes these exact bytes, not the submission wrapper or a
pretty-printed copy. A 404 means **no committed result**; it does not prove
that a check was never issued or that a scheduled check was missed.

Save the raw receipt as your own evidence. The reference checker in the
repository replays it with `bun gate check receipt.json`.
The optional `cloudflare/examples/verify-receipt.mjs` adds a mandatory issuer
pin and optional expected context/session/hash checks around that same
checker:

```console
bun cloudflare/examples/verify-receipt.mjs receipt.json --issuer "$EXPECTED_ISSUER_PUBLIC_KEY"
```

It returns `ok` for evidence validity and `pass` for the independently rescored
outcome; a valid failed check has `ok: true, pass: false`. It also returns the
checked policy and signed times so the application can enforce its own
acceptance rules. Answered challenge receipts disclose their seeds; missing
or malformed answers count as nonpassing without a per-challenge receipt.
Applications must additionally enforce their expected policy, context,
session, and freshness. A valid signature under an arbitrary embedded key is
not sufficient to trust a result.

The staging issuer is published at `GET /v1/issuer`. Its current pinned public
key is `4_1Qbm1y84b4ZAYJtFt7bhLL1WHv7vPsOXHP0XRUW2g`, key ID
`fbedfce73b678cf9`. Establish this trust through an operator-controlled source;
do not learn an expected key from the same untrusted receipt being checked.

A receipt describes the responding system under the recorded conditions. It
does not identify the model that answered; the docs list
[everything a check does not prove](https://clankdar.com/docs/#security). A
single check says nothing about availability, so a monitoring application
must keep its own schedule, issued checks, timeouts, and misses.

## Storage and operational limits

Each completed check is stored as **one JSON receipt** in the
`clankdar-evidence-staging` R2 bucket at `checks/<id>.json`. The receipt
embeds its challenge receipts; no separate receipt objects are written. The
first successful conditional write becomes the result. The stored receipt is
immutable and hash-verifiable, but its key is the check ID, not its content
hash.

Issuance returns an AES-GCM sealed ticket containing the temporary secret
session. Its authenticated context binds the protocol, environment, issuer,
and check ID; its encrypted data binds the policy, deadline, and optional
subject/context. Issuing a check creates no per-check database row or session
object. One atomic counter in the staging D1 database enforces the issuance
limits below; it is separate from receipt storage.

- Standalone checks share a lifetime limit of 1,024 issued checks and a limit
  of 60 issues per fixed UTC minute. Failed issuance after reservation may consume a
  slot conservatively. These limits are separate from legacy actor quotas.
- Submission bodies are limited to 128 KiB and receipts to 256 KiB. Reads
  and retries do not create extra receipt objects.
- Receipts aren’t deleted automatically, but this experimental service
  doesn’t promise to keep them; keep your own copies.
- Inputs that become evidence are public. Do not submit private context,
  personal information, provider credentials, or invitation tokens as answers.
- Clankdar does not call a model. Applications choose and pay for their own
  solver and own request/token/spending limits.

Staging has not been load-tested, and its throughput and per-check costs
have not been measured. Don’t plan production traffic around it.

## Deployment and recovery

The Worker checks invitation tokens against its `REGISTRATION_TOKEN` secret.
Apply the additive standalone-quota D1 migration before deploying this API.
It creates a new counter table and leaves actor/anchor data untouched. Keep
the existing issuer and wrapping secrets, Cloudflare identities, and R2
bucket. Do not reset counters or overwrite receipt keys. Old `sha256/*`
evidence, actor events, campaigns, and public pages remain intact.

Before migration, inspect the exact database and preserve an export/recovery
point. Old code can be restored while leaving the additive quota table and
any new receipts in place. After deployment, verify issuer continuity,
passing/failing checks, contradictory concurrent submissions, retry after
expiry, exact receipt hashes, independent replay, and preservation across a
redeploy. Qualification controls must be labeled as scripted, not reported
as model benchmark results.
