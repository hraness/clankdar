# Hosted Clankdar delivery plan — atomic checks

## Outcome

Fresh capability checks with portable, verifiable receipts. An integrator issues one check, supplies its own solver, submits one response set, and retains a signed JSON result. No actor registration, campaign, profile, or schedule is required. Scheduling, aggregation, identity, and application acceptance policy remain with the integrator.

The user revised the earlier campaign-first direction after PRs #36 and #37. Those changes established durable evidence and a reference workflow; existing records remain intact. This plan supersedes the earlier product framing. The [check API contract](clankdar-checks-v1.md) defines the new core; the [actor/campaign guide](clankdar-hosted-v1.md) remains an optional reference.

## Implementation and acceptance

1. **Atomic check API and storage.** Reuse the existing challenge/scoring/signature primitives and `clankdar-gate-v1` receipt format. Issue encrypted, authenticated tickets. Store one canonical admission at `checks/<id>.json` in the existing R2 bucket with a conditional create. The storage commit accepts the result; races and uncertain retries recover the stored winner. Authenticate a ticket before recovering its result, and recover committed results before enforcing expiry. A small atomic D1 counter limits issuance independently of receipt storage. No new per-agent or per-session database is introduced.
2. **Portable integration and verification.** HTTP is sufficient for issuance, submission, and retrieval. Provide small opt-in examples, with no built-in model provider or unbounded process. Offline verification must distinguish valid embedded signatures from an application-pinned issuer, expected context/session, policy, and freshness.
3. **Simple public product.** Lead the homepage and docs with issue → answer → receipt. Show a complete curl quickstart and practical recipes for preflight, release regression checks, listing evidence, and integrator-owned monitoring. Keep existing identity/campaign concepts out of core onboarding and retain benchmark calibration as supporting evidence. Preserve the pinned visual system, accessibility, and static-site constraints.
4. **Independent review and validation.** Cover optional key binding, ticket tampering, expiry, contradictory concurrent submissions, uncertain/failed R2 writes, quota races, canonical byte hashes, protocol replay, and legacy preservation. Review source independently, run the required aggregate after convergence, and inspect desktop/mobile/light/dark browser output in bounded passes.
5. **Delivery and live evidence.** Publish a current-head PR; merge after required checks. Inspect exact provider identities and the additive D1 migration; preserve a recovery export. Apply migration, deploy existing Worker/site, confirm unchanged issuer, exercise bounded scripted live controls, retrieve exact R2 bytes, replay independently, and verify old evidence plus new receipts survive redeployment. Record final branch, checks, PR, versions, and live evidence in the task delivery report.

## Release boundaries

The existing invitation-only staging service and resources are reused. No paid upgrade or new database/bucket/account is needed. Default standalone checks now use `algal-floor-v1` and the official Algal expression evaluator. Explicit `v2-floor-v1` and frontier policies remain frozen and available. The core creates no hosted availability denominator. Receipt content is public, and integrations should retain their own copies rather than assume permanent staging retention.

The issuer and session-wrapping secrets remain unchanged. Existing actor/anchor rows, Durable Objects, signed histories, campaigns, and `sha256/*` objects remain intact. The quota migration is additive, and a code rollback can leave its table and new receipt objects untouched. No counter reset or data deletion is part of delivery.

No AI provider is called implicitly. Qualification uses a scripted public-prompt solver and an empty-answer failure control, not a model benchmark. Model identity, uniqueness, independent operation, spend, and authority are not claims of a check receipt. Held-out hosted pools, external anchors, key recovery, public self-service onboarding, and load-tested production capacity are outside this change.

## Algal and product alignment

The follow-up makes Clankdar an application of Algal’s bounded expression
language, not a second implementation. Pin the upstream WASM by commit and
hash; share that evaluator between Bun and Workers. Add a separately versioned
`clankdar-algal-v1` suite and `algal-floor-v1` policy. Preserve all previous
generators, recorded scores, policy IDs, tickets, and stored receipts.

The homepage and README should show an executed Algal program and solution,
a harder frozen practice instance, archive-derived benchmark counts, and a
source-backed comparison with traffic-risk checks, proof-of-work, and request
signatures. Keep the new suite’s lack of model calibration visible. Move
advanced CLI details into a reference guide.

Use the existing shared design-kit header grammar and sticky footer. Validate
compact navigation, header/footer positioning while scrolling, content
clearance, keyboard behavior, and anchored navigation on desktop and mobile.
One integration owner runs the aggregate and browser gates, then the current-head
PR, deployment, exact-site readback, and bounded live Algal/legacy qualification.
