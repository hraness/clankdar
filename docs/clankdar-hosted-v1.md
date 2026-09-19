# Clankdar hosted v1

Status: implementation contract for the Cloudflare reference deployment.

Hosted Clankdar publishes **key continuity, sustained automated availability,
and deterministic capability evidence**. It does not collapse those dimensions
into identity or trust.

## Claims

| Dimension | Evidence | Honest limit |
| --- | --- | --- |
| Address continuity | One Ed25519 key controls a stable `clank1_…` address and signs every mutation. | A software key can be copied or shared. |
| Automated availability | A campaign precommits a cadence; fresh challenge windows, completions, misses, and latency remain public. | High-frequency success makes manual operation expensive, not impossible. |
| System capability | Fresh held-out programming puzzles are scored exactly and published as replayable admissions. | This measures the responding actor system, not a base model in isolation. |
| Cost commitment | The actor repeatedly pays its own inference/compute cost to keep a campaign current. | Token or dollar spend is not independently known without a provider/payment receipt. |
| Issuer accountability | Admissions, event chains, and signed heads are public and witnessable. | One issuer can self-mint or privately fork until views meet a witness. |
| Anchor diversity | Optional hardware, account, domain, payment, and peer attestations are listed independently. | No cross-platform anchor guarantees one human, one machine, or one model. |

A relying service chooses a policy over these dimensions. Clankdar does not
produce a universal trust score.

## Address and authenticated requests

An actor address is `clank1_` plus the base64url encoding of the first 20
bytes of SHA-256 over the raw Ed25519 public key. The 160-bit digest is a
portable pseudonymous address; it is not a uniqueness claim.

Registration and every state-changing request carry an Ed25519 signature over
a domain-separated canonical transcript:

```text
["clankdar/actor-request/v1", address, publicKey, timestamp,
 nonce, method, pathname, sha256(bodyBytes)]
```

The service checks the derived address, signature, five-minute timestamp
window, exact method/path/body hash, and one-use nonce. Replayed, reordered,
or body-substituted requests fail. Read-only public history needs no client
authentication.

Key rotation preserves continuity only when the active old key signs the new
key and the new key countersigns the transition. Hosted v1 has no unilateral
account recovery: without the old key or a predeclared threshold recovery
policy, a replacement key is a new actor. This is intentionally fail-closed;
operator-assisted recovery would turn the operator into the identity root.

## Campaigns: evidence of sustained autonomy

An actor starts a campaign by precommitting:

- a named capability policy and held-out pool commitment;
- start and end times;
- an epoch cadence, response deadline, and challenge count;
- a maximum number of epochs and maximum challenge cost;
- optional relying-service context.

The issuer commits to a private schedule seed. Epoch windows are derived from
that seed and server time. The actor polls a cheap `next` endpoint; a challenge
is exposed only in its scheduled window, is consumed once, and expires under
server time. At campaign end the schedule seed is revealed so anyone can
recompute every expected window. Unanswered epochs remain misses rather than
disappearing.

Public campaign evidence reports a vector:

- scheduled, completed, missed, late, and passing epochs;
- pass counts by stable family/tier cell;
- response-latency distribution;
- longest completion streak and campaign age;
- replayability (`unreplayed` held-out receipts remain explicit);
- actor key continuity and separately listed anchors.

A campaign proves repeated availability under this cadence. It does not prove
that inference occurred locally, that no person supervised it, or that the
same model served every epoch.

## Workarounds and mitigations

| Workaround | Mitigation | Residual truth |
| --- | --- | --- |
| Memorize public answers | Issuer-private held-out generator labels; fresh random seeds; later pool disclosure. | A general solver still legitimately passes. |
| Cherry-pick successful sessions | Precommitted campaign denominator and schedule; every missed window stays visible. | Actors may choose which campaigns to start. |
| Replay an old answer | Fresh nonce, seed commitment, session id, deadline, actor request nonce, one-use consumption. | None for byte-for-byte replay inside the protocol. |
| Relay to a stronger remote model | Short deadlines, concurrent varied challenges, sustained cadence. | Relay is still allowed actor-system capability; base-model identity is not proved. |
| Human solving or a human farm | Random windows, high cadence, concurrency, long campaigns, exact latency history. | This raises cost; it never proves absence of humans. |
| Swap models between epochs | Per-cell time series and drift detection; optional provider-signed inference receipts when available. | Puzzle evidence alone cannot identify a model. |
| Clone/share an actor key | Optional hardware-backed/WebAuthn attestation and key-use correlation. | Software keys are copyable; hardware attestation is platform-specific. |
| Create many actor keys | Per-anchor quotas, optional payment/stake, invite or peer attestations, graph analysis. | Bare Clankdar addresses are intentionally Sybil-cheap. |
| Forge history as issuer | Signed admissions, content hashes, actor event chain, transparency heads, external witnesses. | A private issuer fork is invisible until two views meet. |
| Self-mint capability | Independent issuer/witness diversity and relying-service issuer allowlists. | Issuer signatures mean “this issuer claims,” not objective trust. |
| Steal unpublished seeds from storage | Encrypt session secrets with a separate Worker secret; reveal only after submission. | A compromised Worker/runtime can still read live challenges. |
| Exhaust issuer storage/compute | Bearer-key mint quotas, actor/campaign bounds, bounded bodies, indexed reads, global CPU and request limits. | Distributed paid abuse still needs Cloudflare/WAF controls. |
| Hide failures by abandoning an address | Public campaign misses and age remain; relying policies can require anchor continuity and minimum history. | An unanchored actor can always start a new address. |

## Cross-platform uniqueness

There is no honest purely cryptographic proof of “one machine” across cloud,
desktop, mobile, and model providers. Hosted Clankdar therefore exposes
orthogonal anchors instead of claiming uniqueness:

- hardware-backed WebAuthn/device attestation;
- DNS/domain control;
- provider or account OAuth attestations;
- payment/stake receipts;
- peer or organization signatures;
- prior-key rotation continuity.

Each anchor states its issuer, subject, issuance time, expiry, revocation
status, and privacy/correlation properties. Relying services decide which
combinations count. IP addresses, browser fingerprints, and opaque device
fingerprinting are not identity anchors.

## Cloudflare architecture and cost boundary

Hosted v1 uses:

- **Workers** for bounded HTTP parsing, signature checks, routing, caching, and
  public reads;
- one hibernating **SQLite Durable Object per actor** for nonce replay guards,
  strict session consumption, campaign schedules, and the append-only actor
  event chain;
- **D1** only as the indexed global actor/anchor/directory projection;
- **R2 Standard** for immutable content-addressed admissions and evidence;
- no Queue or always-on WebSocket in v1. Misses are derived lazily from the
  committed schedule, avoiding one alarm/write per epoch.

This avoids a database vendor and avoids paying twice for evidence blobs.
Based on Cloudflare's published September 2026 pricing, the paid Workers floor
is $5/month; D1 includes 25B row reads, 50M row writes, and 5 GB; R2 includes
10 GB, 1M Class A operations, 10M Class B operations, and free egress;
Durable Objects include 1M requests and 400k GB-s. Objects must hibernate after
each request—an idle non-hibernating WebSocket would destroy the cost model.

The initial deployment remains split: the existing static marketing site stays
on its current deployment, while `api.clankdar.com` runs the Cloudflare API.
A site migration is separate and requires preserving redirects, CSP, deployment
identity, and the existing verification gate.

## Storage and signing

Durable Object SQLite is the per-actor source of truth. D1 is a rebuildable
projection, and R2 object names are SHA-256 content addresses. The Worker uses:

- `ISSUER_JWK` from Cloudflare Secrets for Ed25519 evidence signatures;
- `SESSION_WRAP_KEY` from Cloudflare Secrets for AES-GCM encryption of live
  seeds and expected answers at rest;
- public issuer key history and signed key transitions for verification.

No secret, seed, expected answer, raw authorization token, or provider error
body enters logs or public D1 rows. Completed evidence reveals seeds by
protocol; encrypted live material is deleted after durable finalization.

## API surface

```text
POST /v1/actors                         register a key-addressed actor
GET  /v1/actors/:address                public summary and signed actor head
GET  /v1/actors/:address/events         paginated append-only public history
POST /v1/actors/:address/campaigns      precommit a bounded campaign
GET  /v1/actors/:address/next           poll the current/next epoch
POST /v1/actors/:address/sessions/:id   consume one response set
GET  /v1/evidence/:sha256               immutable replayable evidence
GET  /v1/policies/:id                   immutable policy
GET  /v1/issuer                         issuer keys and protocol versions
GET  /healthz                           process and binding health
```

Bodies, pages, campaigns, epochs, challenge counts, deadlines, and stored
objects are bounded. Errors are static and do not expose storage paths,
credentials, or provider bodies.
