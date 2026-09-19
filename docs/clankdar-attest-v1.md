# clankdar-attest-v1 + clankdar-gate-v1 + clankdar-tlog-v1 + clankdar-badge-v1

Sealed-seed capability attestation, the admission-session profile built on
it, and the issuance transparency log derived from the gate ledger. The
TypeScript reference is `bench/attest.ts` + `bench/gate.ts` + `bench/tlog.ts`;
an independent Rust implementation lives in
[hraness/valhalla](https://github.com/hraness/valhalla/tree/main/prototypes/clankdar-attest).

**Status: experimental reference.** The hosted issuer surface (§16) is a
reference implementation, not a production deployment; witnessed head
transport and hardware binding are not implemented. A receipt or admission
is evidence about one bounded episode — never identity, liveness,
personhood, or authority.

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
- `prove tlog.json --from-count N` emits a
  `clankdar-tlog-consistency-v1` proof (§19): the suffix entries the log
  added after the `count:N` boundary a verifier pinned.
- `check-proof proof.json --old-head head.json` (or `--old-tip HEX
  --old-count N`) replays that suffix against the pin — a pinned-head
  holder confirms growth without fetching or re-checking the whole log.
- `admit tlog.json ADMISSION.json [--pool POOL.json]` runs the full §8
  admission check AND requires the admission's `sessionId` to have both a
  session and a decision entry in a log that itself verifies. Held-out
  receipts without the matching disclosed pool remain valid but surface as
  `unreplayed`; supplying the pool upgrades them to fully replayed evidence.
- `witness --heads heads.jsonl tlog.json` runs the full `check`, then
  appends the log's head to a local head registry (below). Re-witnessing
  an identical head is a no-op, not an error.
- `equivocate --heads heads.jsonl` compares the registry's heads under
  each issuer key and exits 2 on a proven fork.
- `compare LOG_A.json LOG_B.json` decides whether two full logs under one
  issuer key are identical, strict-prefix consistent, or forked (§17).
- `witness-serve --heads heads.jsonl [--host H] [--port N] [--providers
  PROVIDERS.json] [--poll-ms N]` exposes the provider-neutral common
  intake in §18, optionally polling configured providers too.

### Head witnessing

A **head registry** (`heads.jsonl`) is the checker side of fork
detection: an append-only local record of the signed heads an operator
has witnessed, one normalized `TlogHead` per line, indexed by
`verifier.keyId`. Unknown members are tolerated at intake but stripped
before storage because the signature covers only the protocol fields.
Replay mirrors the ledger rules — a torn tail is
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
signed heads themselves. `witness-serve` (§18) adds explicit common
intake plus automatic polling of configured providers, and full-log
comparison (§17) decides different-length forks when both views are
available, and §19 lets a pinned-head holder verify later growth from a
linear suffix proof. What is still missing is provider discovery and
witness-to-witness transport — gossip, witnessed co-signing, external
anchoring — and logarithmic Merkle proofs: the chain is a linear hash
chain by design, so consistency evidence is a linear suffix, not a
Merkle path. What the log buys is enumerability:
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
  implements local and HTTP witness intake (§11, §18) with optional
  configured-provider polling, same-count and same-tip findings from
  heads, and full-log fork comparison (§17). It does not implement
  provider discovery, gossip, witnessed co-signing, or external
  anchoring.
- **Per-family solver scripts.** Public generators admit canned solvers:
  a receipt proves "access to a solver for this cell," still real friction
  for anti-spam, weaker as a competence claim. Held-out pools (§15)
  re-parameterize published generators with secret labels so the instance
  stream is unpublished — they defeat instance lookup and per-cell
  precomputation, but a general solver for the family still solves them,
  and third-party checkers without the pool cannot replay the score (the
  signature, commitment, timing, and subject proof still verify).
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

Current coverage: the Rust crate independently checks attest-v1 receipts
(including §7 subject proofs), gate-v1 admissions, tlog-v1 logs
(`check_log`, `prove_session`, and the logged-admission test, with optional
pool disclosure via `check_logged_admission_with_pool`/`tlog admit --pool`),
and holdout-v1 pools, receipts, and admissions against TypeScript-generated
fixtures. Its rooms dogfood issues, submits, and decides gate admissions
pinned to a room floor and verifier key; it fails closed on held-out scores
unless they were replayed. badge-v1, head witnessing, fork comparison,
consistency proofs, and the hosted HTTP surfaces are TypeScript-only for
now.

## 14. Portable subject badges (badge-v1)

A respondent holding subject-bound admissions (§7) under one Ed25519 key can
pack them into a **badge** — a self-signed, portable dossier a third party
replays without contacting anyone. The subject signs, never an issuer: a
badge is a curated claim "these signed episodes are bound to my key", not an
issuer attestation. Admissions from different verifier keys mix freely —
cross-issuer aggregation is the point.

`BadgeBody` (inside the signed payload):

```json
{
  "kind": "badge",
  "subjectKey": "<base64url Ed25519 JWK x>",
  "admissions": [ "<Admission>", "..." ],
  "proofs": [ { "log": "<TransparencyLog>", "proof": "<SessionProof>" } ],
  "issuedAt": "2026-09-18T00:02:00.000Z"
}
```

`admissions` holds 1–64 entries; `proofs` is optional. The envelope mirrors
the receipt and admission envelopes:

```json
{
  "protocol": "clankdar-badge-v1",
  "payload": "<canonical JSON of BadgeBody>",
  "signature": "<base64url Ed25519 by subjectKey over the payload bytes>"
}
```

### Badge check

A checker MUST:

1. parse the envelope and payload; require `kind:"badge"`, the
   `clankdar-badge-v1` protocol, and a `subjectKey` that decodes as an
   Ed25519 JWK `x` member;
2. require `admissions` to hold 1–64 entries, each passing the §8 admission
   check, with distinct `sessionId`s — one decision per session (§9). When
   holdout pools are disclosed, index up to 64 distinct pools by `poolKey`
   and replay each admission against its matching pool; sum every admission's
   remaining `unreplayed` receipt count rather than treating issuer-claimed
   scores as fully replayed;
3. require every admission to be subject-bound: every embedded receipt that
   carries a `subjectProof` MUST use `publicKey === subjectKey`, and at
   least one receipt MUST carry a proof — the session-scoped transcript
   binds the whole session, so one proof covers its admission. An admission
   with no `subjectProof` at all is not subject-bound and cannot be
   included;
4. when `proofs` is present, require it to be an array of at most 64
   `{log, proof}` entries and replay each under the §11 rules: the log
   passes `checkLog`, `proof.sessionId` names a session the badge carries,
   the claimed `sessionIndex`/`decisionIndex`/`head` equal a fresh
   `proveSession` result over that log, and `decisionIndex` is non-null —
   a badge proof asserts the admission's *decision* is logged, not merely
   its session;
5. require `issuedAt` to parse as RFC 3339;
6. verify the badge signature over the payload bytes verbatim under
   `subjectKey`.

Domain separation is implicit in the shape: the badge signature covers the
badge payload under the subject key, so it can never be a §7 subjectProof
transcript (a different message with a different layout), and a receipt or
admission signature can never be a badge signature — those verify under
issuer keys, not the subject's. No `BADGE_DOMAIN` label is needed.

### Honest limits

A badge proves exactly that the subject key accumulated these signed
admissions. It does **not** prove the key holder solved anything — §7
delegation survives aggregation — and it does **not** prove the admissions
were earned: an issuer can always self-mint for a colluding subject, which
is why `tlog` inclusion proofs are optional but recommended (an admission
whose session has no logged decision is issuer-claimed only). A badge result
with `unreplayed > 0` also contains held-out score claims the checker could
not regenerate; `passed` reports signed verdicts, not proof that those scores
were replayed. Pool disclosure is checker input, never embedded secret
material in the badge. A badge is a dossier, not an identity: it carries no
liveness or revocation of its own, verdicts inside it may be passes or fails,
and it grants no authority.

Commands (reference: `bench/badge.ts`):

- `pack --subject-key KEY.json --admissions a.json,b.json [--proofs
  proofs.json] [--pools p1.json,p2.json] [--out badge.json]` packs a badge
  and replays it through the checker before emitting — `proofs.json` is
  `[{log, proof}]` assembled by the caller (`tlog build` + `tlog prove`).
- `check badge.json [--pools p1.json,p2.json]` → `{ok, subject,
  admissions, verdicts:{pass}, logged, unreplayed?}`; pools from multiple
  issuers may mix and are selected by committed `poolKey`; exit 2 on failure.

## 15. Held-out pools (holdout-v1)

A holdout pool re-parameterizes published generator cells with secret
labels so the issued instance stream is unpublished. It is the
issuer-side answer to per-cell precomputation: a solver cannot look up or
pre-solve instances it has never seen a sample of, while the issuer still
produces receipts under the same sealed-seed attestation protocol.

### Pool file

```json
{
  "protocol": "clankdar-holdout-v1",
  "suite": "frontier",
  "poolKey": "<sha256 hex>",
  "cells": [{ "family": "sat", "tier": 4, "label": "<base64url>" }]
}
```

- `suite` names the published generator pool the labels re-parameterize.
- `label` is a secret base64url string (>=128 bits) — it is the only
  private material. The held-out instance for a cell is
  `generate(tier, mixSeed(label, seed))`: the label decorrelates the
  cell's stream from the published one while the public `seed` stays the
  caller seed recorded in the receipt.
- `poolKey` commits the whole pool:
  `sha256(canonical({protocol, suite, cells}))`. Checkers recompute it
  from the file; a mismatched key means a tampered or wrong pool.

The file is issuer-private (mode `0600` in the reference CLI) until the
issuer chooses disclosure.

### Challenge marker and policy cells

A challenge minted from a pool carries `heldout: {poolKey}`; its
`family`/`tier` name base-suite cells and `suiteVersion` names the base
suite. In a gate policy, held-out cells are written `h:family:tN` (e.g.
`h:sat:t4`) alongside published `family:tN` cells — the issuer's pool
must contain every `h:` cell the policy names, and the pool's `suite`
must equal the policy's. Within one admission all held-out challenges
carry the same `poolKey`.

### Checking

`checkReceipt(receipt, {pool?})` produces three outcomes:

- **Verified** — the checker holds a pool whose `poolKey` matches the
  marker and which contains the cell: the instance regenerates from
  `label + seed` and the full attest procedure runs (prompt, answer,
  rescore, timing, subject proof).
- **Invalid** — signature, commitment, shape, binding, or (for pool
  holders) pool membership/regeneration fails. A challenge naming a cell
  absent from its committed pool is fabricated and fails outright.
- **Issuer-claimed** — `ok:true` with `replayable:false`: no matching
  pool was supplied, so the envelope (signature, seed commitment, timing,
  subject proof, answer-format and expected-answer canonicality) verified
  but the instance and score could not be replayed. Relying parties
  decide whether issuer-claimed cells satisfy their policy.

`checkAdmission(admission, {pool?})` applies the same rules: `h:` cells
are validated against the pool when supplied and syntactically otherwise;
the checker reports `unreplayed` — the count of receipts whose scores
could not be independently regenerated.

### Honest limits

- A held-out cell is the *same puzzle family* under an unpublished
  parameterization. It defeats instance memorization, lookup, and
  stream-specific tuning; a solver that handles the family class still
  solves it. Unpublished puzzle *types* require generator delivery
  outside this document.
- Without the pool, `poolKey` commits to *a* pool, not to a *sound* one —
  the issuer could have labeled degenerate cells. Deferred disclosure is
  the accountability hook: publish the pool and every historical
  held-out receipt upgrades to fully verifiable, including the soundness
  of the cell list.
- Pool compromise reveals only labels; rotating to a fresh pool changes
  `poolKey` and leaves prior receipts verifiable under the retired pool.

Commands (reference: `bench/holdout.ts`, `bench/attest.ts`,
`bench/gate.ts`):

- `holdout gen --suite frontier --cells sat:t4,knights:t5 --out
  pool.json` mints a pool with fresh secret labels (writes `0600`).
- `holdout info pool.json` re-parses and prints the commitment.
- `attest issue --holdout pool.json`, `attest verify --pool pool.json`,
  `attest check receipt.json --pool pool.json` mint, decide, and check
  standalone held-out episodes.
- `gate ... --pool pool.json` on `policy`, `issue`, `submit`, `check`,
  `serve`, and `probe` wires the pool through sessions; `serve` with an
  `h:` policy requires it.

## 16. Hosted issuer surface

`bench/hosted.ts` composes the gate service (§10) and the transparency
log (§11) into one HTTP deployment — the reference shape of a hosted
issuer. Every §10 route is served unchanged (the hosted service delegates
to the gate's own request handler rather than re-implementing it), and
three read-only endpoints publish the ledger-derived log:

```
GET /tlog                    → TransparencyLog {head, entries}
GET /tlog/head               → the signed TlogHead — what a witness pins
GET /tlog/proof/:sessionId   → SessionProof {sessionId, sessionIndex,
                               decisionIndex, head} | 404 unlogged session
```

Every `/tlog` read replays the ledger and re-signs the head, so a served
head always commits the current ledger — the cost is O(ledger size) per
request and there is no cache that could go stale; a production
deployment would rebuild on append or on a bounded interval. Entries
publish only record digests and metadata — never seeds, tickets,
responses, or admissions — so the ledger file itself stays private (the
reference forces the state dir to `0700`). Published entries do name
sessionIds, and a live session id is already a bearer capability at
`POST /sessions/:id/responses` (submission is unauthenticated by design),
so serving the log in real time makes open sessions enumerable to
watchers — deployments that care should decide sessions promptly or
publish on a delay.

Commands (reference: `bench/hosted.ts`):

- `hosted serve --key K --policy P --dir STATE [--pool POOL.json]
  [--auth-keys KEYS.jsonl] [--host H] [--port N] [--open-total N]
  [--open-per-subject N] [--issue-window MAX:SEC]` — the gate's flags pass
  through unchanged, including holdout pools and the ledger-derived rate
  limits.
- `hosted head --dir STATE --key K` prints the current signed head — the
  artifact an external witness pins for §11 equivocation detection.
- `hosted keys issue --keys KEYS.jsonl [--name X] [--quota-mints N
  --quota-window DUR] [--quota-open N]` mints a client key and prints the
  raw `clk_…` bearer token once — the file stores only its SHA-256.
  `hosted keys list` and `hosted keys revoke --key-id K` inspect and
  revoke; revocations are appended records, so effective state is the
  fold, matching the ledger's append-only rules.

### Client authentication (optional)

`--auth-keys` opts the write path into issuer-side bearer keys
(`bench/keys.ts`). When set, `POST /sessions` requires `Authorization:
Bearer clk_…`; missing, malformed, unknown, and revoked tokens all get
one identical static `401 {ok:false,reason:"unauthorized"}`, so a probing
client cannot tell whether a keyId ever existed. Each key may carry
quotas — `openSessions` (live sessions the key minted, joined against the
ledger's live set) and `mintsPerWindow` (a rolling mint cap) — enforced
in addition to the §10 ledger-derived rate limits; a quota failure is a
static `429 {ok:false,reason:"quota"}`. Accepted mints append `mint`
records to the same JSONL file, so quotas hold across restarts.

Client keyIds are authorization bookkeeping only: they never enter
`gate-state.jsonl` or the transparency log, so published entries cannot
reveal which key minted a session. `POST /sessions/:id/responses` stays
unauthenticated by design — a live session id is already the unguessable
capability that submit consumes, and per-key auth on mint is the control
that bounds ledger spam. A client key authorizes ledger writes for this
issuer; it is not identity, personhood, or authority. Without
`--auth-keys` every route behaves exactly as before.

### Honest boundary

Hosting publishes evidence; it does not create trust. A hosted issuer can
still self-mint — the verifier can always answer its own oracle — and can
still fork: nothing stops it from serving one log to one client and a
different log to another. The signed head is the accountability hook: a
witness that pins `/tlog/head` output over time, or across vantage
points, accumulates exactly the signed artifacts `equivocate` compares.
Heads still have to reach a common witness before they can be compared.
The explicit intake in §18 accepts them and can poll configured
providers' `/tlog/head` endpoints automatically; provider discovery,
gossip, witnessed co-signing, and external anchoring remain
unimplemented. This is a reference surface, not a production deployment:
TLS termination and high-availability operation are out of scope, and
the optional bearer keys are write authorization for the ledger — never
client identity.

## 17. Fork comparison over published logs

`findEquivocation` (§11) decides equivocation from witnessed heads alone
only when two signed heads are directly contradictory: same count with
different tips, or one tip signed at two counts. A different-count pair
with different tips is undecidable there — the registry stores heads, not
entries — so growth and a fork look alike.

`tlog compare LOG_A.json LOG_B.json` decides that case when a verifier
holds both published logs. Each log must pass §11 `checkLog` in full —
chain recompute, index/type/session rules, and a signed head matching the
entries — and both heads must share one verifier keyId. Then the chains
are walked to the first index whose `entryHash` differs:

- a divergence is a **proven fork**: two internally valid chains, each
  closing under the issuer's own signature, committing different content
  at a shared index. `ok:false`, `equivocation:true`, `forkIndex`, and
  both counts are reported; the CLI exits 2.
- no divergence over the shared prefix is **consistent**: identical
  chains, or a strict prefix in either direction — ordinary growth or a
  stale copy, reported as `relation` with `ok:true`.

### Honest limits

The evidence is the two published logs themselves — a consistency proof
(§19) can show a log extends a pinned head, but it cannot show two logs
diverge, so there is still no compact fork proof. Comparison detects a
fork only between two logs a
verifier actually holds — an issuer can still fork privately, serving
different logs to different parties, and nothing is detected until both
views reach one verifier. Logs signed by different verifier keys are not
comparable (they are not one issuer's histories). A strict-prefix result
does not prove the shorter log was issued first — head timestamps are
issuer-chosen.

## 18. Provider-neutral head witness

`tlog witness-serve --heads HEADS.jsonl [--host H] [--port N] [--providers
PROVIDERS.json] [--poll-ms N]` exposes an explicit common intake for
signed tlog heads. It is multi-provider by construction: every `TlogHead`
embeds an Ed25519 public key, its derived `keyId`, and the signature, so
the witness needs no provider registry or provider-specific adapter.
Findings are always scoped to one `keyId`; heads under different keys
never conflict.

HTTP surface:

- `POST /heads` accepts one `TlogHead` (maximum 16 KiB). The witness checks
  protocol, shape, timestamp, derived `keyId`, and Ed25519 signature before
  appending. Unknown members are accepted for forward compatibility but
  stripped before storage because they are not covered by the v1 signature.
  An identical signed claim is idempotent. The response reports `recorded`,
  total `witnessed` heads, `providerHeads` for this key, and any proven
  `equivocation` for the submitted key.
- `GET /heads?keyId=K&after=N&limit=M` returns a bounded page (default 100,
  maximum 1,000). `keyId` is optional; when present it isolates one provider.
  `next` is the next offset or null.
- `GET /equivocation/:keyId` runs §11 head comparison for exactly one
  provider key.
- `GET /status` reports per-provider poll state — the configured `url`,
  `lastPollAt`, `lastResult` (`ok` / `fetch-error` / `invalid-head`), and
  the accepted head's `keyId` — plus `pollMs` and a `providersFile` flag
  when the last providers-file read failed. Entries are bounded (the URL
  is operator-supplied configuration, never a secret) and carry no raw
  error strings.
- `GET /healthz` reports process health.

### Provider polling

With `--providers PROVIDERS.json`, the witness polls each listed
provider's `GET /tlog/head` every `--poll-ms` milliseconds (default
60,000, bounded 1..86,400,000). The file is a JSON list of `{url}`
entries — `{providers: [...]}` is accepted too — up to 256 unique
http(s) base URLs, and it is **re-read every cycle**, so operators add
or remove providers without a restart. An unreadable, oversized, or
malformed file logs a bounded stderr warning and skips that cycle; the
service stays up.

Each fetched head goes through exactly the `POST /heads` path: bounded
16 KiB body (10s fetch timeout), shape and signature check, unknown
members stripped, then append — except a fetched head whose `count`+tip
is identical to the latest stored head for its `keyId` is not
re-appended, so a provider re-signing the same claim every cycle cannot
spam the registry. An unreachable provider or an invalid head records
nothing and surfaces only as a stderr warning plus the `/status`
`lastResult`.

A provider URL is configuration, **not trust**: only each head's own
embedded verifier signature decides what is recorded, the registry
bucket is the embedded `keyId` rather than the source URL, and two
providers serving different keys stay isolated — even two providers
serving contradictory heads under one key, which is exactly the
equivocation evidence the registry exists to collect.

The backing file is the same append-only registry used by `tlog witness`
and `tlog equivocate`, so CLI and HTTP observations converge on one evidence
format. A provider key rotation starts a new independent history unless an
external identity system links the keys; Clankdar does not infer that link.

### Honest limits

The service is an experimental intake, not gossip or a production witness.
It does not discover providers, co-sign observations, anchor them
externally, authenticate submitters or providers, impose provider quotas,
or replicate its registry. Anyone can submit a valid harvested head, and a
provider controlling a signing key can create enough valid heads to consume
the registry bound. A private fork remains invisible until both signed views
reach this or another common witness — polling only closes the transport
gap for providers the operator already chose to configure. TLS
termination, abuse controls, high-availability storage, and
witness-to-witness transport belong outside this reference process.

## 19. Append-only consistency proofs (tlog-consistency-v1)

A client that pinned a signed head at count `N` — a witnessed `TlogHead`
from §11/§18, or a remembered `{count, tip}` — can verify that a later,
larger log is a chain-extension of what it pinned without replaying the
whole chain. `clankdar-tlog-consistency-v1` is that proof: the
transparency-log analogue of a CT consistency proof, carried by the
linear hash chain rather than a Merkle tree.

```json
{
  "protocol": "clankdar-tlog-consistency-v1",
  "oldCount": 4,
  "oldTip": "<entryHash of entry oldCount-1; 64 zeroes at genesis>",
  "newCount": 8,
  "newTip": "<entryHash of the last entry — equal to head.head>",
  "suffix": [ "<TlogHashedEntry>", "..." ],
  "head": "<TlogHead>"
}
```

`suffix` is `entries[oldCount..newCount)` — the new entries only. Its
first entry's `prev` IS the linkage back to the pinned tip: in a linear
hash chain, the entry after the boundary commits to the boundary hash, so
the suffix carries its own anchor and needs no auxiliary hashes.

### Producing and checking

- `tlog prove tlog.json --from-count N` emits the proof for the boundary
  after entry `N` — `0` is genesis (the whole log, equivalent to full
  replay) and `count` is an empty suffix.
- `tlog check-proof proof.json --old-head head.json` verifies against a
  witnessed signed head; `--old-tip HEX --old-count N` verifies against a
  bare remembered pin. A nonzero `oldCount` with neither is unverifiable
  and the checker fails closed — only the genesis boundary (the public
  64-zero constant) is self-authenticating.

A checker MUST:

1. require `protocol`, nonnegative integer counts with `oldCount ≤
   newCount`, 64-hex `oldTip`/`newTip`, and `suffix.length === newCount −
   oldCount`;
2. resolve the trusted boundary from the pin, never from the proof's own
   claims: a signed-head pin MUST pass the §11 signed-head checks and have
   `count === oldCount`; then `proof.oldTip` MUST equal the pinned tip;
3. replay the suffix: `suffix[i].index === oldCount+i`, every field
   well-formed, `suffix[0].prev === oldTip`, each later `prev` linking the
   previous `entryHash`, and every `entryHash` recomputing;
4. require the recomputed tip to equal `newTip` — an empty suffix is
   valid iff `oldTip === newTip`;
5. require `head` to pass the §11 signed-head checks with `count ===
   newCount` and `head === newTip`, and — when the pin was a signed head —
   signed by the same `verifier.keyId`.

### Security statement

The proof is sound because the chain is linear: the first suffix entry's
`prev` is the old tip by construction, so matching it against a trusted
pin and recomputing the suffix to the signed new tip proves extension.
It proves ONLY that the new log extends the pinned head, and ONLY IF the
pinned head was authentic — the verifier must have obtained it through
head witnessing (§11, §18) or an equivalent trusted channel. It does NOT
prove the new log is the issuer's only extension: an issuer can fork
after the boundary and both forks verify against the same pin, so fork
accountability still needs both views to reach a common witness. The
proof is compact in growth — `O(newCount − oldCount)` entries — not O(1)
or Merkle-logarithmic; the log is a linear hash chain by design.
Finally, suffix entries are hash-checked but NOT replayed for ledger
semantics — a decision may legitimately name a session issued before the
boundary — so `checkLog` on the full log remains the semantic check.
