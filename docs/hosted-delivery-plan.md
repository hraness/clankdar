# Hosted Clankdar delivery plan — atomic checks

## Outcome

Fresh capability checks with portable, verifiable receipts. An integrator issues one check, supplies its own solver, submits one response set, and retains a signed JSON result. No actor registration, campaign, profile, or schedule is required. Scheduling, aggregation, identity, and application acceptance policy remain with the integrator.

The user revised the earlier campaign-first direction after PRs #36 and #37. Those changes established durable evidence and a reference workflow; existing records remain intact. This plan supersedes the earlier product framing. The [check API contract](clankdar-checks-v1.md) defines the new core; the [actor/campaign guide](clankdar-hosted-v1.md) remains an optional reference.

## Implementation and acceptance

1. **Atomic check API and storage.** Reuse the existing challenge/scoring/signature primitives and `clankdar-gate-v1` receipt format. Issue encrypted, authenticated tickets. Store one canonical admission at `checks/<id>.json` in the existing R2 bucket with a conditional create. The storage commit accepts the result; races and uncertain retries recover the stored winner. Authenticate a ticket before recovering its result, and recover committed results before enforcing expiry. A small atomic D1 counter limits issuance independently of receipt storage. No new per-agent or per-session database is introduced.
2. **Portable integration and verification.** HTTP is sufficient for issuance, submission, and retrieval. Provide small opt-in examples, with no built-in model provider or unbounded process. Offline verification must distinguish valid embedded signatures from an application-pinned issuer, expected context/session, policy, and freshness.
3. **Simple public product.** Lead with browser practice → a complete local signed receipt → the hosted integration. Practice needs no install or signup and makes no attestation. `bun run try` uses a scripted solver and temporary local signer without credentials or model calls; an opt-in solver module shares the hosted helper callback. Offer the Node/Bun HTTP helper directly, make invitation access discoverable, and retain curl controls, benchmark evidence, and protocol details as deeper references. Preserve the pinned visual system, accessibility, and static-site constraints.
4. **Independent review and validation.** Cover optional key binding, ticket tampering, expiry, contradictory concurrent submissions, uncertain/failed R2 writes, quota races, canonical byte hashes, protocol replay, and legacy preservation. Review source independently, run the required aggregate after convergence, and inspect desktop/mobile/light/dark browser output in bounded passes.
5. **Delivery and live evidence.** Publish a current-head PR; merge after required checks. Inspect exact provider identities and the additive D1 migration; preserve a recovery export. Apply migration, deploy existing Worker/site, confirm unchanged issuer, exercise bounded scripted live controls, retrieve exact R2 bytes, replay independently, and verify old evidence plus new receipts survive redeployment. Record final branch, checks, PR, versions, and live evidence in the task delivery report.

## Release boundaries

The existing invitation-only staging service and resources are reused. No paid upgrade or new database/bucket/account is needed. Default standalone checks now use `algal-floor-v1` and the official ALGAL expression evaluator. Explicit `v2-floor-v1` and frontier policies remain frozen and available. The core creates no hosted availability denominator. Receipt content is public, and integrations should retain their own copies rather than assume permanent staging retention.

The issuer and session-wrapping secrets remain unchanged. Existing actor/anchor rows, Durable Objects, signed histories, campaigns, and `sha256/*` objects remain intact. The quota migration is additive, and a code rollback can leave its table and new receipt objects untouched. No counter reset or data deletion is part of delivery.

No AI provider is called implicitly. Qualification uses a scripted public-prompt solver and an empty-answer failure control, not a model benchmark. Model identity, uniqueness, independent operation, spend, and authority are not claims of a check receipt. Held-out hosted pools, external anchors, key recovery, public self-service onboarding, and load-tested production capacity are outside this change.

## ALGAL and product alignment

The follow-up makes Clankdar an application of ALGAL’s bounded expression
language, not a second implementation. Pin the upstream WASM by commit and
hash; share that evaluator between Bun and Workers. Add a separately versioned
`clankdar-algal-v1` suite and `algal-floor-v1` policy. Preserve all previous
generators, recorded scores, policy IDs, tickets, and stored receipts.

The homepage leads with an interactive public ALGAL example and the shortest
path to a complete local receipt. Deeper docs retain the harder frontier
example, archive-derived benchmark counts, and source-backed comparison with
traffic-risk checks, proof-of-work, and request signatures. Keep the new
suite’s lack of model calibration visible. Advanced CLI details stay in the
reference guide.

Use the existing shared design-kit header grammar and sticky footer. Validate
compact navigation, header/footer positioning while scrolling, content
clearance, keyboard behavior, and anchored navigation on desktop and mobile.
One integration owner runs the aggregate and browser gates, then the current-head
PR, deployment, exact-site readback, and bounded live ALGAL/legacy qualification.


## Conversion follow-up acceptance

- Browser practice gives immediate local feedback and another public example,
  with a native worked solution when JavaScript is disabled. It makes no API
  or provider request and issues no signed receipt.
- The next action runs `bun run try` after the documented clone/install steps.
  It writes a real canonical receipt and verification record, verifies them,
  and clearly identifies the scripted control and temporary local issuer.
- The docs show one `solve(challenges, signal)` callback shared by the local
  demo and downloadable Node/Bun HTTP helper. Custom solver execution remains
  explicit and caller-funded.
- Hosted access is an explicit request link. Tokens and live tickets stay on
  the server; verification requires a trusted issuer pin and app acceptance
  rules. Curl failure controls and optional protocol features are secondary.
- Existing deep links, benchmark evidence, shared header/footer, no-form and
  same-origin static-site constraints remain intact. Root owns aggregate,
  browser, delivery, and production verification after lane convergence.
