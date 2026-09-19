# Hosted Clankdar completion plan — 2026-09-19

## Outcome

A public record of what an agent system can solve and whether it keeps responding. A user registers a local signing key, commits to a bounded campaign, connects their own solver, and shares a readable profile backed by signed, replayable results. Availability and capability stay separate; all scheduled misses count.

## Recovered state and audit

The authoritative continuation is the `miniature-caraway` main chain in Devin's local session database. Its JSON transcript was an older export. PRs #34 and #35 delivered the Cloudflare actor foundation and free-plan staging. The `feat/hosted-campaigns` branch contains the unfinished campaign/client implementation. Its final edits had not been tested. The previous local secrets directory was deleted after upload; issuer and wrapping secrets must remain unchanged.

Staging is `https://clankdar-hosted-staging.972abc65.workers.dev`. The public marketing site remains the existing Hraness Vercel `clankdar` project. No new paid resource or custom-domain migration is required for this delivery.

Release blockers found:

- Concurrent and interrupted mutations can split state from signed event history or issue conflicting evidence.
- Lazy catch-up omits elapsed misses from availability denominators; historical scans grow with campaign length.
- Body limits apply after reading, and staging needs explicit actor and lifetime campaign/epoch capacity bounds.
- The CLI leaves operators to coordinate every poll and response; there is no readable public profile.
- Marketing and documentation describe the benchmark while denying or misdescribing the implemented hosted API. Future held-out pools/anchors are mixed with present claims.

## Execution and acceptance

1. **Backend correctness and capacity** — serialize actor transitions, atomically commit outcomes and events, retain a frozen evidence outbox for retry, count all elapsed misses, bound per-request catch-up and staging capacity. Regressions cover concurrent requests, duplicate submission, R2 interruption/retry, elapsed schedules and malformed requests.
2. **Simple operator loop** — sensible campaign defaults; explicit bounded `run --solver FILE --campaign ID`; stdin/stdout JSON; no implicit model calls; deadline/output/process cleanup; fresh request nonces on recoverable retries. Key material stays local and is never given to the solver.
3. **Public product** — readable actor/campaign records, signed-evidence links, clear no-data states, same-origin pinned presentation. Homepage leads with the hosted journey, docs offer a complete start-to-finish example, benchmark remains supporting calibration.
4. **Independent review and integration** — review changed behavior, run the required aggregate once after convergence, run Worker deploy dry-run and desktop/mobile/light/dark browser checks, fix any observed failures.
5. **Delivery and live qualification** — current-head PR with passing required checks, merge, deploy to the existing targets; verify issuer identity unchanged, staged resources/config, one bounded campaign including pass/fail/miss evidence, persistence across redeploy, independently replayed admission and public HTML/assets.

## Deliberate v1 boundaries

This is an invitation-only, capacity-limited experimental staging service. It measures the responding system, including tools or relays. It does not identify a base model, prove independent operation, measure dollar spend, establish uniqueness, or grant authority. The shipped puzzles use fresh secret seeds over public generators; issuer-private held-out pools, external anchors, key rotation/recovery and payment receipts are future work. These add different claims and should not delay an honest, usable initial product. Lost actor keys require a new address.

No AI provider is called by default. A solver is explicitly selected by the operator and pays its own compute costs. The runner stops at an explicit local budget; it does not run indefinitely or create campaigns automatically. Campaign misses remain public when the operator stops.

## Validation and deployment record

Implementation and independent source review are complete. The initial aggregate passed 308 Bun tests, 9 Cloudflare runtime tests, both typechecks, archived evidence replay and both asset builds. The browser gate exercised 30 page/viewport/theme combinations at 1280, 390 and 320 pixels in light and dark modes, plus no-script access. Visual inspection found missing shared theme attributes on the new profiles; the correction and explicit theme/font assertion are included before final validation.

Delivery requires fresh current-head CI, merge, Worker dry run/deployment, unchanged issuer identity, a live qualification actor with passed/failed/missed checks, independent admission replay, and persistence after redeployment. The live qualification control solves public prompts algorithmically and is not a model-capability benchmark. The final delivery record is supplied with the task closeout.
