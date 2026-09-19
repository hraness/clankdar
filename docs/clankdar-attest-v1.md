# clankdar-attest-v1 + clankdar-gate-v1 + clankdar-tlog-v1

Sealed-seed capability attestation, the admission-session profile built on
it, and the issuance transparency log derived from the gate ledger. The
TypeScript reference is `bench/attest.ts` + `bench/gate.ts` + `bench/tlog.ts`;
an independent Rust implementation lives in
[hraness/valhalla](https://github.com/hraness/valhalla/tree/main/prototypes/clankdar-attest).

**Status: experimental reference.** No hosted service, held-out pools, or
hardware binding is implemented. A receipt or admission is evidence about one
bounded episode — never identity, liveness, personhood, or authority.

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
subjectProof?, verdict:{pass, format, answeredAt}}`. `expected` is the
canonical answer; `format` is the family answer format. `subjectProof`
(optional, §7) embeds inside the signed payload like every other member.

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
9. require `answeredAt ≤ challenge.expiresAt`;
10. when `subjectProof` is present in the body, require the §7 subject-proof
    check to pass.

A valid receipt attests exactly: this response was scored this verdict against
this instance inside this window, signed by this verifier key. When the
receipt carries a `subjectProof`, it additionally attests that the holder of
that key signed the challenge's subject transcript (§7) — the response is
bound to a respondent key, still not to a model or a person.

## 7. Subject binding (optional)

A receipt MAY carry a `subjectProof` that binds the response to an Ed25519 key
the respondent controls:

```json
"subjectProof": { "publicKey": "<base64url>", "signature": "<base64url>" }
```

`publicKey` is a base64url Ed25519 JWK `x` member — the same encoding as
verifier keys, and the same keygen produces respondent keys. `signature` is a
base64url Ed25519 signature by that key over a domain-separated transcript
built from the recorded challenge:

- **Session-scoped** — the challenge carries `sessionId` (a gate session):
  `canonical(["clankdar/subject/v1", sessionId, publicKey])`.
  One proof covers every challenge in the session, so a gate submit carries a
  single `subjectProof` and the same object embeds in every minted receipt.
- **Challenge-scoped** — a standalone challenge (no `sessionId`):
  `canonical(["clankdar/subject/v1", challengeId, nonce, publicKey])`.

The domain label separates subject proofs from receipt and admission
signatures, and from the seed commitment, so a proof can never be reinterpreted
as any other message in the protocol.

Issuer behavior: `verify` validates the proof's shape and requires the
signature to verify over the transcript for that challenge; an invalid proof
is a minting error, never a receipt field — no receipt is produced.

Checker behavior: when `subjectProof` is present in the receipt body, a
checker MUST require `{publicKey, signature}` to be strings, recompute the
transcript from the recorded challenge per the scope rule above, and require
the Ed25519 signature to verify under `subjectProof.publicKey`. An admission
checker MUST additionally require that every embedded receipt carrying a
`subjectProof` uses the same `publicKey` — one subject per session. Receipts
and admissions without proofs remain fully valid; checkers ignore unknown
members as before.

What it proves: the holder of `publicKey` signed the transcript covering this
challenge (or this session), and the verifier embedded that proof inside the
signed receipt — so one pseudonymous subject key can sign across receipts,
sessions, and verifiers, enabling portable capability badges and
receipt-chaining. What it does NOT prove: that the key holder produced the
answer — a subject may delegate solving exactly as before (§12); a proof binds
a key to a response, never a model, a person, or an authority, and it carries
no liveness, expiry, or revocation of its own beyond the challenge window.

## 8. clankdar-gate-v1 — admission sessions

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
supplies a response or leaves it unanswered, plus at most one session-scoped
`subjectProof` (§7) that embeds in every minted receipt. Each format-canonical
response is verified into a receipt; the issuer runs the independent check on
each minted receipt before signing the admission. A missing or non-canonical
response is a failed challenge with no receipt — completeness lives in the
signed challenge list, so a failed challenge cannot be hidden.

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
6. every embedded receipt carrying a `subjectProof` uses the same
   `publicKey` — one subject per session;
7. `verdict.passed` equals the count of passing receipts,
   `verdict.required === policy.minPass`,
   `verdict.pass === (passed ≥ minPass)`;
8. `decidedAt ≤ expiresAt`.

## 9. Ledger requirements (serving a gate)

An operator serving admissions MUST:

- keep tickets secret until the receipt reveals them;
- consume each session **once**, atomically and durably across restarts —
  the reference `bench/store.ts` appends one JSONL record per session and one
  per decision (receipts + admission together), fsyncs each record, drops a
  torn tail on replay, and refuses re-decision;
- refuse submissions for unknown, decided, or expired sessions;
- bound every input (response count, body size, answer length).

An in-memory guard alone is not a production admission ledger. The
`clankdar-tlog-v1` transparency log (§11) is a derived signed view over
this same ledger.

## 10. HTTP surface (reference)

```
GET  /healthz                       → {ok:true}
GET  /policy                        → {protocol, policy, verifier:{keyId,publicKey}}
POST /sessions                      {subject?, context?} → 201 {sessionId, expiresAt, challenges[]}
                                    429 over a configured rate limit
POST /sessions/:id/responses        {responses:{challengeId:response}, subjectProof?} → 200 {admission, receipts}
                                    404 unknown · 409 decided · 410 expired
GET  /receipts/:challengeId         → receipt | 404
```

The check→decide critical section is synchronous, so concurrent submits
cannot double-spend a session.

`serve` accepts optional rate limits (`--open-total`, `--open-per-subject`,
`--issue-window MAX:SECONDS`). `openTotal` bounds live sessions — issued,
undecided, unexpired — across the gate; `openPerSubject` bounds them per
subject claim (anonymous requests share one bucket); `issueWindow` paces
global issuance per rolling window. All counts derive from the ledger, so
limits hold across restarts. The hard bounds are global: subject claims are
unauthenticated and can be rotated, so per-subject limits pace fairness and
cannot exclude a sybil.

## 11. Issuance transparency (tlog-v1)

The gate ledger (§9) records every session and every decision, but only the
issuer sees it. `clankdar-tlog-v1` is a derived, signed view over that
ledger (`gate-state.jsonl`); it makes issuance accountable without changing
the gate protocol.

Each ledger record becomes one hash-chained entry:

```json
{
  "index": 0,
  "type": "session",
  "sessionId": "gs_…",
  "digest": "<64 hex>",
  "prev": "<64 hex>",
  "entryHash": "<64 hex>"
}
```

- `digest` = `SHA-256(canonical(record))` over the verbatim ledger record —
  `{type:"session", session}` or `{type:"decision", sessionId, admission,
  receipts}`.
- `prev` = the previous entry's `entryHash`; the genesis entry uses 64
  zeroes.
- `entryHash` = `SHA-256(canonical(entry body))` over the five fields
  above, excluding `entryHash`.

The issuer signs a head — the analogue of a CT signed tree head:

```json
{
  "protocol": "clankdar-tlog-v1",
  "kind": "head",
  "count": 4,
  "head": "<entryHash of the last entry>",
  "issuedAt": "2026-09-18T00:02:00.000Z",
  "verifier": { "keyId": "…", "publicKey": "<base64url>" },
  "signature": "<base64url Ed25519 over canonical(head minus signature)>"
}
```

An empty log signs `count: 0` with the genesis `head` (64 zeroes).

Commands (reference: `bench/tlog.ts`):

- `build --dir GATE_STATE_DIR --key verifier.json [--out tlog.json]`
  replays the ledger under the same rules as `GateStore` — a torn tail is
  dropped; mid-log corruption, duplicate sessions, and decisions for
  unknown or decided sessions are fatal — and emits `{head, entries}`.
- `check tlog.json` recomputes every `entryHash` and `prev` link, enforces
  ledger semantics on entry order (a session is issued once; a decision
  names an issued, still-open session), recounts, and re-verifies the head
  `keyId` and signature.
- `prove tlog.json --session gs_…` emits `{sessionId, sessionIndex,
  decisionIndex, head}` — the inclusion evidence a third party needs:
  `check` the log, then confirm the session was issued (sessionIndex) and
  its decision logged (decisionIndex; null while undecided).
- `admit tlog.json ADMISSION.json` runs the full §8 admission check AND
  requires the admission's `sessionId` to have both a session and a
  decision entry in a log that itself verifies — `{ok, verdict, passed}`.
- `witness --heads heads.jsonl tlog.json` runs the full `check`, then
  appends the log's head to a local head registry (below). Re-witnessing
  an identical head is a no-op, not an error.
- `equivocate --heads heads.jsonl` compares the registry's heads under
  each issuer key and exits 2 on a proven fork.

### Head witnessing

A **head registry** (`heads.jsonl`) is the checker side of fork
detection: an append-only local record of the signed heads an operator
has witnessed, one verbatim `TlogHead` per line, indexed by
`verifier.keyId`. Replay mirrors the ledger rules — a torn tail is
dropped, mid-file corruption or a line that fails head shape or
signature verification is fatal (a recorded head is evidence; an
unverifiable one is corruption), and a file over 1,000,000 lines is
refused. `witness` only records the head of a log that itself passes
`check`.

`equivocate` compares every pair of recorded heads under one `keyId` and
proves equivocation in two airtight cases:

- **same count, different tip** — two equal-length chains cannot end at
  different `entryHash` values, so both heads cannot describe real logs;
- **same tip, different count** — an `entryHash` commits to its index,
  so one tip cannot close both a count-4 and a count-6 chain.

Either finding exits 2 and reports `{ok:false, keyId, conflict:[headA,
headB], reason}` — the conflicting pair is the evidence.

A `count` that decreases in `issuedAt` order is reported only as a
`warnings` entry (`reason: "head counts regress"`): issue timestamps are
issuer-controlled, so a regression is soft evidence — reported, never an
exit-2 finding on its own. And a different-length fork in general (a
shorter head that is not an ancestor of a longer one) cannot be decided
here: the registry stores heads, not entries, so no ancestry proof is
possible without the underlying logs.

The honest limit: the log binds *this* issuer's history under *its own*
key. It does not stop self-minting — a verifier can always answer its own
oracle — and a single log cannot detect a fork alone: an issuer could
show different parties different logs. Fork detection is now implemented
as local head comparison: `witness` accumulates every head an operator
sees and `equivocate` proves the same-count and same-tip cases from the
signed heads themselves. What is still missing is transport — heads must
reach a common witness before they can be compared — so gossip, witnessed
co-signing, and external anchoring remain future work, as do ancestry
proofs for different-length forks. What the log buys is enumerability:
every session and decision the issuer stands behind is committed,
ordered, and replayable, so an admission that does not trace to a logged
session is issuer-claimed only.

## 12. Threat model — say it plainly

- **Delegation.** A receipt binds a response to a window; an optional
  `subjectProof` binds it to a respondent key — but the key holder can still
  relay the challenge to a stronger solver and sign the transcript
  afterward. The proof says who claimed the episode, not who solved it.
  Friction claims are robust to this; credential claims are not.
- **Verifier self-minting.** The verifier knows every expected answer and can
  attest to itself. For self-issued admission this is meaningless by design
  (a service trusting its own gate). Portable third-party badges are checked
  against the issuance transparency log (§11): an admission that does not
  trace to a logged session is issuer-claimed only. The log is issuer-keyed,
  so fork detection needs published-head comparison; the reference
  implements a local witness registry (§11) that proves same-count and
  same-tip forks, but head transport — gossip, witnessed co-signing,
  external anchoring — is not implemented.
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

## 13. Interoperability

The Rust prototype regenerates instances through `bench/instance.ts` (the
generator oracle: `--suite`/`--suite-version --family --tier --seed` →
`{prompt, answer}`), so canonical generation stays single-sourced. Receipt,
admission, and transparency-log formats are language-neutral; the canonical
JSON, seedCommit, and entry-chain constructions are deliberately trivial to
reimplement.
