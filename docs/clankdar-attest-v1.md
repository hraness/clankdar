# clankdar-attest-v1 + clankdar-gate-v1

Sealed-seed capability attestation, and the admission-session profile built on
it. The TypeScript reference is `bench/attest.ts` + `bench/gate.ts`; an
independent Rust implementation lives in
[hraness/valhalla](https://github.com/hraness/valhalla/tree/main/prototypes/clankdar-attest).

**Status: experimental reference.** No hosted service, rate limiting, held-out
pools, or hardware binding is implemented. A receipt or admission is evidence
about one bounded episode — never identity, liveness, personhood, or authority.

## 1. Primitive

A verifier commits to a fresh unrevealed seed and publishes the generated
prompt. The instance has never existed publicly, so it cannot be pre-solved or
looked up. A respondent answers inside a deadline. The verifier regenerates
the instance from the seed, rescores deterministically, and signs a receipt
that reveals the seed. Anyone then replays the whole episode: signature, seed
commitment, regeneration, rescore, timing — no trust in the verifier beyond
what it signed.

## 2. Encoding

- **Canonical JSON**: `JSON.stringify` with object keys sorted by code-unit
  order, recursively. Signatures cover the canonical serialization verbatim;
  checkers verify over the recorded payload bytes and never re-serialize.
- **Base64url** (`base64url`, no padding) for nonces, ids, signatures, and key
  material.
- **Keys**: Ed25519 JWK private key `{kty:"OKP", crv:"Ed25519", x, d}`.
  `publicKey` is the `x` member (base64url). `keyId` is the first 16 hex chars
  of `SHA-256(base64url-decoded publicKey bytes)`.
- **Ids**: `challengeId` = `"att_" + base64url(9 random bytes)`;
  `sessionId` = `"gs_" + base64url(9 random bytes)`; `nonce` =
  `base64url(12 random bytes)`; `seed` = uint32.
- **Timestamps**: RFC 3339 / ISO 8601 UTC.

## 3. Seed commitment

```
seedCommit = SHA-256(
  "clankdar/attest-seed/v1" \0
  suiteVersion            \0
  family                  \0
  tier                    \0
  nonce                   \0
  seed                    (decimal uint32)
)  → hex
```

The commitment binds the instance identity (suite version, family, tier,
nonce) to the hidden seed. It does not bind `prompt` or `verifier` — those are
bound by the receipt signature instead. Domain separation keeps the digest
unambiguous.

## 4. Challenge

```json
{
  "protocol": "clankdar-attest-v1",
  "kind": "challenge",
  "challengeId": "att_…",
  "suiteVersion": "clankdar-frontier-v1",
  "family": "registervm",
  "tier": 5,
  "prompt": "…",
  "seedCommit": "<64 hex>",
  "nonce": "<base64url>",
  "expiresAt": "2026-09-18T00:05:00.000Z",
  "context": "jobs-board",            // optional, ≤ 256 chars
  "subject": "agent-7",               // optional, nonempty ≤ 256 chars
  "sessionId": "gs_…",                // optional; gate session binding
  "verifier": { "keyId": "…", "publicKey": "<base64url>" }
}
```

Required members are fixed. `context`, `subject`, and `sessionId` are optional
and, when present, are covered by the receipt signature. Unknown members may
appear in future versions; checkers MUST ignore unknown members rather than
reject.

## 5. Verify → receipt

Verifier-side `verify` recomputes the commitment (ticket seed must match),
enforces the deadline, regenerates the instance (its prompt must equal the
recorded prompt), rescores with `clankdar-score-v2`, and signs:

```json
{
  "protocol": "clankdar-attest-v1",
  "payload": "<canonical JSON of ReceiptBody>",
  "signature": "<base64url Ed25519 over payload bytes>"
}
```

`ReceiptBody` = `{kind:"receipt", challenge, seed, expected, response,
verdict:{pass, format, answeredAt}}`. `expected` is the canonical answer;
`format` is the family answer format.

## 6. Independent check

A checker MUST:

1. parse the envelope and payload; require `kind:"receipt"` and protocol;
2. rebuild the verifying key from `challenge.verifier.publicKey` and require
   `keyIdOf(publicKey) === challenge.verifier.keyId`;
3. verify the Ed25519 signature over the payload bytes verbatim;
4. require `seed` a uint32 and `seedCommit === recomputed commitment`;
5. regenerate the instance from `(suiteVersion, family, tier, seed)` and
   require `instance.prompt === challenge.prompt`;
6. require `expected` canonical for the format and equal to the regenerated
   answer;
7. require the recorded `response` format-canonical (a response that is not
   in the declared format is unverifiable and cannot produce a valid
   receipt — gates treat it as a failed challenge with no receipt);
8. rescore `(expected, response, format)` and require equality with
   `verdict.pass`;
9. require `answeredAt ≤ challenge.expiresAt`.

A valid receipt attests exactly: this response was scored this verdict against
this instance inside this window, signed by this verifier key.

## 7. clankdar-gate-v1 — admission sessions

A **policy** is the floor a relying party applies:

```json
{
  "suite": "frontier",
  "cells": ["automata:t6", "knights:t5", "registervm:t5"],
  "challenges": 3,
  "minPass": 2,
  "ttlSeconds": 300
}
```

- `cells`: 1–64 distinct `family:tier` ids, all present in the suite pool.
- `challenges`: 1–16, drawn uniformly from `cells` **with replacement**.
- `minPass`: 1..challenges. `ttlSeconds`: 10..3600.

A **session** mints `challenges` sealed challenges under one `sessionId` and
one shared `expiresAt` (each challenge carries `sessionId`, and optionally
`subject`/`context`). The verifier keeps tickets (seed + expected)
server-side; the respondent sees only challenges.

A single **submit** consumes the session. For every challenge, the respondent
supplies a response or leaves it unanswered. Each format-canonical response is
verified into a receipt; the issuer runs the independent check on each minted
receipt before signing the admission. A missing or non-canonical response is
a failed challenge with no receipt — completeness lives in the signed
challenge list, so a failed challenge cannot be hidden.

### Admission

```json
{
  "protocol": "clankdar-gate-v1",
  "payload": "<canonical JSON of AdmissionBody>",
  "signature": "<base64url>"
}
```

`AdmissionBody` = `{kind:"admission", sessionId, policy, subject?, context?,
challenges[], receipts[], verdict:{pass, passed, required, decidedAt}}` where
`challenges` is the complete session list and `receipts` has at most one per
challenge.

### Admission check

A checker MUST additionally require:

1. the embedded policy parses and `challenges.length === policy.challenges`;
2. every challenge: `sessionId === body.sessionId`, `suiteVersion` consistent
   with `policy.suite`, `family:tier ∈ policy.cells`, identical `expiresAt`
   (one window), identical verifier key, `subject`/`context` equal to the
   admission's;
3. challenge ids unique;
4. the admission signature verifies over the payload bytes with the
   challenges' verifier key;
5. every embedded receipt passes the §6 check and canonical-equals a listed
   challenge (no grafted receipts, at most one per challenge);
6. `verdict.passed` equals the count of passing receipts,
   `verdict.required === policy.minPass`,
   `verdict.pass === (passed ≥ minPass)`;
7. `decidedAt ≤ expiresAt`.

## 8. Ledger requirements (serving a gate)

An operator serving admissions MUST:

- keep tickets secret until the receipt reveals them;
- consume each session **once**, atomically and durably across restarts —
  the reference `bench/store.ts` appends one JSONL record per session and one
  per decision (receipts + admission together), fsyncs each record, drops a
  torn tail on replay, and refuses re-decision;
- refuse submissions for unknown, decided, or expired sessions;
- bound every input (response count, body size, answer length).

An in-memory guard alone is not a production admission ledger.

## 9. HTTP surface (reference)

```
GET  /healthz                       → {ok:true}
GET  /policy                        → {protocol, policy, verifier:{keyId,publicKey}}
POST /sessions                      {subject?, context?} → 201 {sessionId, expiresAt, challenges[]}
POST /sessions/:id/responses        {responses:{challengeId:response}} → 200 {admission, receipts}
                                    404 unknown · 409 decided · 410 expired
GET  /receipts/:challengeId         → receipt | 404
```

The check→decide critical section is synchronous, so concurrent submits
cannot double-spend a session.

## 10. Threat model — say it plainly

- **Delegation.** A receipt binds a response to a window, not a subject.
  Anyone can relay the challenge to a stronger solver. Friction claims are
  robust to this; credential claims are not.
- **Verifier self-minting.** The verifier knows every expected answer and can
  attest to itself. For self-issued admission this is meaningless by design
  (a service trusting its own gate). Portable third-party badges need an
  issuance transparency log — not implemented.
- **Per-family solver scripts.** Public generators admit canned solvers:
  a receipt proves "access to a solver for this cell," still real friction
  for anti-spam, weaker as a competence claim. Held-out pools restore the
  stronger claim at the cost of weaker public verifiability — not
  implemented.
- **Not sybil resistance.** One strong solver backs unlimited identities;
  the gate prices each admission, never proves uniqueness.
- **Suite decay.** Published cells get trained on. Suites are versioned;
  floors should rotate cells and tiers over time.
- **No authority.** An admission may inform a rate limit or an admission
  decision. It must never, by itself, grant tool access, authorize a
  payment, or make a message trustworthy.

## 11. Interoperability

The Rust prototype regenerates instances through `bench/instance.ts` (the
generator oracle: `--suite`/`--suite-version --family --tier --seed` →
`{prompt, answer}`), so canonical generation stays single-sourced. Receipt
and admission formats are language-neutral; the canonical JSON and seedCommit
constructions are deliberately trivial to reimplement.
