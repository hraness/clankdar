# Clankdar

**Fresh capability checks. Portable, verifiable receipts.**

Issue puzzles over HTTP, submit one set of answers, and keep the signed JSON
result. Clankdar supplies deterministic tasks, exact scoring, and evidence
that another system can replay. Your application chooses when to check, who
to associate it with, and how to use the result.

The core API needs no actor registration, public profile, or campaign. Each
completed result is one canonical JSON object in R2; D1 holds a small issue
quota counter. The benchmark and optional scheduling examples build on the
same receipt primitives.

Guides and evidence: [clankdar.com](https://clankdar.com).
The hosted API is experimental private staging; the operator supplies issue
tokens. A receipt measures submitted answers under recorded conditions, not
model identity, autonomy, ongoing availability, uniqueness, safety, or authority.

## Make one check with HTTP

Use curl and jq from a fresh directory. Set `CLANKDAR_TOKEN` privately to your
invitation token, keeping it on your server. No repository checkout, Bun,
agent key, or model-provider configuration is required for this HTTP demo.

```console
export CLANKDAR_URL="https://clankdar-hosted-staging.972abc65.workers.dev"
# Set CLANKDAR_TOKEN privately to your invitation token.
umask 077
curl -fsS "$CLANKDAR_URL/v1/checks" \
  -H "Authorization: Bearer $CLANKDAR_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"policyId":"v2-floor-v1"}' > check.json
jq -r '.challenges[] | "\(.challengeId)\n\(.prompt)\n"' check.json
```

The default `v2-floor-v1` policy returns four prompts, requires three passing
answers, and allows 120 seconds. The response includes actual challenge IDs,
`expiresAt`, and a private ticket for this check. Creating it does not call a
model. Build an answer map using those real IDs:

```console
jq '.challenges | map({key: .challengeId, value: ""}) | from_entries' \
  check.json > answers.json
```

Blank values make this an intentionally failed-check demo. Submit them as-is
to exercise the complete receipt flow without calling a model, or replace
them with actual solver answers before the check expires. A failed check
consumes the attempt too. Missing or malformed answers produce no challenge
receipt or seed reveal; the blank-answer demo still verifies as 0 of 4 passing.

```console
jq -n --slurpfile check check.json --slurpfile answers answers.json \
  '{ticket: $check[0].ticket, responses: $answers[0]}' > submission.json
curl -fsS "$CLANKDAR_URL/v1/checks/$(jq -r '.id' check.json)/responses" \
  -H "Content-Type: application/json" \
  --data-binary @submission.json > result.json
jq '{id, pass, passed, required, receiptUrl, sha256}' result.json
curl -fsS "$CLANKDAR_URL$(jq -r '.receiptUrl' result.json)" > receipt.json
```

Submission needs the scoped ticket, not your issue token. The first accepted
submission fixes the result; submission retries recover that same result.
Retrying creation issues a new check and consumes another quota slot. `receipt.json`
is the raw signed `clankdar-gate-v1` admission, with `protocol`, `payload`, and
`signature`. Its public URL remains readable after the ticket expires.
Download your own copy; experimental storage has no automatic deletion policy
but is not a permanent-archive guarantee.

## Embed the primitive

- **Agent preflight:** create a check when an agent offers to take a job, then
  apply your service's own authentication and admission policy to the result.
- **Release CI:** compare checks under fixed conditions with a declared
  baseline and attach receipts to the release.
- **Agent listings:** display a recent result and a link to the underlying
  evidence in your own marketplace or directory.
- **Scheduled monitoring:** call the same endpoints from your own cron job.
  Your app owns cadence, budgets, missed-run treatment, and alerting; a single
  check makes no ongoing-availability claim.

The [server-side JavaScript example](cloudflare/examples/check.mjs) connects the
requests to a solver you supply through `solve(challenges, signal)`. Forward
the abort signal to your provider call. Clankdar does not select or run a
model for you; your solver owns provider calls and inference costs. Use the
optional `checkpoint(record)` callback to retain the ticket and answers
privately before submission if your integration needs recovery after a
process exit.

## Verify and retain the result

From the repository with Bun 1.3.14, the optional verifier reuses the existing
independent checker. Configure the expected issuer public key in your app;
do not accept an arbitrary signer merely because its signature is valid.

```console
bun cloudflare/examples/verify-receipt.mjs receipt.json \
  --issuer "$EXPECTED_ISSUER_PUBLIC_KEY" \
  --session "$(jq -r '.id' check.json)" \
  --sha256 "$(jq -r '.sha256' result.json)"
```

Add `--context` when required by your integration. Verification checks the
signature and replays the scoring; also require your intended policy,
freshness, and passing verdict before making a decision. Failed results can
have valid receipts. See the [verifier](cloudflare/examples/verify-receipt.mjs)
and [check API contract](docs/clankdar-checks-v1.md).

The two hosted policies ask four prompts and require three passes:
`v2-floor-v1` has a 120-second deadline; `frontier-floor-v1` has 180 seconds.
Optional issue fields are `context` (a nonempty string up to 256 characters) and
`subjectPublicKey` (requiring a matching subject proof on submission).
Results are public: do not include private context or responses. Keep tickets
private until consumed or expired and issue tokens server-side.

Shared staging is capped at 1,024 lifetime issued checks and 60 issues per
minute, with 128 KiB request bodies and 256 KiB receipts. These are global
limits, not separate allowances for each token. The atomic API uses fresh
public-stream puzzles, not issuer-private held-out pools.

Existing actor/campaign records and routes remain available as an
[optional legacy reference](docs/clankdar-hosted-v1.md). They are not required
for the check API. The examples show possible applications; they do not
prescribe your product's workflow.

## Run the local benchmark

The local benchmark compares responses under a declared suite and budget.
It does not require a hosted invitation. Use **Bun 1.3.14**.

```console
bun install --frozen-lockfile --ignore-scripts
bun run check
bun test                                        # determinism + answer verification
bun bench --list                                # families and their tiers
bun bench --adapter oracle --seeds 1-10 --out results/oracle-first.jsonl
```

`oracle` is a privileged runner control that uses the known answer; it is not
a model score. `echo` returns the prompt. Real adapters receive only family,
tier, and prompt, never the answer or seed. Results contain a run manifest,
one JSONL record per attempt, and a summary by family, tier, cell, and seed.

Model invocations **default to a dry run**:

```console
bun bench --adapter openai:gpt-4o-mini --tiers 0-3 --seeds 101-110
bun bench --adapter openai:gpt-4o-mini --tiers 0-3 --seeds 101-110 \
  --execute --max-requests 200 --max-tokens 4096 --out results/model-first.jsonl
```

Set `CLANKDAR_API_KEY` privately in the environment. `CLANKDAR_BASE_URL`
selects an OpenAI-compatible endpoint; the `OPENAI_API_KEY` and
`OPENAI_BASE_URL` equivalents are fallbacks. No-key loopback HTTP endpoints
are supported for local models; remote endpoints must use HTTPS. Environment
files, credentials, and private run directories stay gitignored.

Local model CLIs run through `cli:<program>:<model>` — currently `cli:claude`.
The adapter spawns one pinned program per instance with every built-in and
MCP tool disabled (`claude -p --tools "" --strict-mcp-config`), so the model
gets a single unaided text turn; provider stderr never enters recorded
results:

```console
bun bench --adapter cli:claude:opus --tiers 0-3 --seeds 101-110 \
  --execute --max-requests 200 --out results/claude-first.jsonl
```

`--max-requests` bounds model calls, including rejected-parameter negotiation.
`--max-tokens`, `--timeout-ms`, and `--concurrency` bound individual attempts.
There are no automatic retries for provider failures. These controls are not a
guaranteed dollar cap; review provider pricing before `--execute`.

Signed gate sessions can be published as a
`clankdar-admission-archive-v1` directory. `bun admission-archive verify DIR`
checks every artifact hash, Ed25519 envelope, seed commitment, regenerated
prompt and answer, typed score, policy, and summary count. The static site
runs that verification before publishing its live admission evidence. An
archive's adapter/model fields are producer provenance, not cryptographic
model identity; the signatures prove the recorded work and verdict, not who
or what performed it.

## Calibrate and inspect

```console
CLANKDAR_BASE_URL=https://ai-gateway.vercel.sh/v1 bun calibrate \
  --models openai/gpt-4.1,google/gemini-2.5-pro --seeds 101-110
bun report results/my-run
bun report site/benchmark/pilot-v0 --exclude gridpath,gridxf,hiddenfn,sequence
bun bench/pilot.ts verify site/benchmark/pilot-v0
```

Calibration also defaults to a dry run. Add `--execute --max-requests N` and
an optional `--out NEW-DIRECTORY` to enable model calls. Model IDs are passed
unchanged to the provider (gateway IDs generally use `provider/model`). Output
files are exclusive-create: existing evidence is never overwritten. Partial
runs are retained, but comparison reports reject incomplete runs, duplicate
instances, different coverage, and conflicting prompt/answer pairs.

### Pilot 0 is evidence, not certification

The public archive under `site/benchmark/pilot-v0/` contains 3,000 legacy
attempt records across twelve requested model aliases, seeds 1–10. One attempt
had a provider error. Synthetic prompts, answers, replies, and timing are kept;
raw upstream error bodies and unknown fields are omitted. Original private
source files are untouched. The manifest records hashes and provenance gaps;
tests and the site build reproduce every report score from the archived data.

The screened report excludes `gridpath` (constant-answer legacy generation),
`sequence` (open recurrence class and inconsistent term count), `hiddenfn`, and
`gridxf` (underspecified rule classes). Full legacy-suite results remain in the
JSON report. The exact dirty run tree, resolved provider versions, effective
negotiated settings, finish reasons, and usage were not recorded in that pilot.

A held-out `clankdar-suite-v2` calibration is also published under
`site/benchmark/v2-calibration-0/`: five requested model aliases, all 25 cells,
seeds 101–120, 2,500 attempts, and one timeout. Strict scores span 9.4%–87.6%,
but pooled tier scores are not monotone because tiers contain different family
mixtures. Treat family/tier cells as capability profiles, not one intelligence
level. The small public rule sets can be memorized, solved with code, or
outsourced; tool-assisted agents require a separately labeled evaluation.

`bench/profiles.ts` partitions all 25 v2 cells into transform fidelity, symbolic
execution, constraint solving, and rule induction. Profile aggregation preserves
raw cell verdicts and reports uncertainty; it is not a universal intelligence
score. Decision-makers should predeclare relevant cells, conditions, sample
sizes, thresholds, and error treatment rather than selecting a policy after
seeing a candidate's results.

## Attestation and admission gates

`clankdar-attest-v1` seals a fresh seed behind a commitment so a challenge
instance cannot be pre-solved; `clankdar-gate-v1` builds admission sessions on
top: N sealed challenges, one deadline, one signed verdict.

```console
bun bench/attest.ts keygen --out verifier.json
bun bench/gate.ts policy --suite frontier --cells automata:t6,knights:t5,registervm:t5 \
  --challenges 3 --min-pass 2 --ttl 300 --out policy.json
bun bench/gate.ts issue --key verifier.json --policy policy.json --out session.json
bun bench/gate.ts submit --key verifier.json --session session.json --responses responses.json
bun bench/gate.ts check admission.json
bun bench/gate.ts serve --key verifier.json --policy policy.json --dir gate-state --port 8787
```

`serve` exposes `POST /sessions`, `POST /sessions/:id/responses`,
`GET /receipts/:challengeId`, and `GET /policy`; sessions and decisions persist
in an append-only ledger that consumes each session exactly once across
restarts. Optional rate limits (`--open-total`, `--open-per-subject`,
`--issue-window MAX:SECONDS`) bound live sessions and mint pacing — counted
from the ledger, so they hold across restarts; subject claims are
unauthenticated, so per-subject limits pace fairness rather than exclude
abuse. `gate probe` points the same machinery at your own model endpoint
and keeps the signed admissions as replayable score-band evidence. The wire
format, checking procedure, and threat model are specified in
[docs/clankdar-attest-v1.md](docs/clankdar-attest-v1.md). The independent
Rust prototype in Valhalla checks attest, gate, tlog, held-out-pool, and
portable-badge artifacts against TypeScript fixtures; its rooms mode dogfoods
admission decisions pinned to one room floor and verifier key.

`bun tlog` derives a signed, hash-chained transparency log over that ledger
(`build`/`check`/`prove`/`admit`). `tlog admit LOG ADMISSION [--pool POOL]`
preserves held-out `unreplayed` counts until the matching pool is disclosed.
`tlog witness --heads heads.jsonl` records
each checked log's signed head in a local append-only registry, and
`tlog equivocate --heads heads.jsonl` proves a fork from two heads under one
issuer key — same count with different tips, or one tip at two counts — and
warns on counts that regress in issue order. `tlog compare A.json B.json`
decides the case heads cannot: two published logs under one key are walked
to the first divergent index — a proven fork — or reported as a consistent
prefix. `tlog prove LOG --from-count N` emits a
`clankdar-tlog-consistency-v1` proof that a larger log extends a previously
pinned `count:N` head, and `tlog check-proof PROOF --old-head head.json`
(or `--old-tip HEX --old-count N`) replays the suffix against the pin —
O(new−old) entries, linear in growth rather than Merkle-logarithmic, since
the log is a linear hash chain by design.
`tlog witness-serve --heads heads.jsonl` is a provider-neutral common
intake: any issuer's self-describing signed head can be submitted, heads are
indexed by their embedded `keyId`, bounded pages can filter by key, and
conflict reports stay isolated per provider. It needs no provider registry.
`--providers providers.json --poll-ms N` additionally polls each configured
provider's `GET /tlog/head` (default 60s, the file re-read every cycle) —
a provider URL is configuration, not trust; only the embedded signature
decides what is recorded. Provider discovery, gossip, witnessed
co-signing, and external anchoring remain unimplemented.

`bun drift` turns probes into monitoring: `drift run` appends each signed
admission to a series file, `drift report` aggregates per-cell pass bands,
`drift baseline` pins a reference, and `drift compare` exits nonzero when a
cell or the overall band drops past `--threshold` — a CI gate for silent model
substitutions and regressions at a probed endpoint.

`clankdar-badge-v1` is the portable-credential layer on top: a respondent
binds each gate session to its own Ed25519 key, then packs subject-bound
admissions — from any issuer — into a badge it signs itself. `bun badge pack`
and `bun badge check` emit and replay the dossier; optional `tlog` inclusion
proofs upgrade issuer-claimed sessions to logged ones. Disclosed
`--pools p1.json,p2.json` may come from many issuers and are selected by
`poolKey`; undisclosed held-out scores remain visible in `unreplayed` rather
than silently appearing fully replayed. A badge proves the subject key
accumulated these admissions — never that the key holder solved them, and it
is not an identity.

`bun hosted` is the deployable issuer surface: one service that composes the
gate and the transparency log, so a deployment third parties can hold
accountable serves every `gate serve` endpoint plus `GET /tlog` (the signed
log rebuilt fresh from the ledger on each request), `GET /tlog/head` (the
signed head an external witness pins), and `GET /tlog/proof/:sessionId`
(inclusion evidence). `bun hosted head` prints that head for pinning;
holdout pools and the rate-limit flags pass through. The state dir stays
`0700` — published entries carry record digests, never seeds or responses.
`bun hosted serve --auth-keys state/keys.jsonl` optionally requires
`Authorization: Bearer clk_…` on `POST /sessions`; `bun hosted keys
issue|list|revoke` manages the append-only key file (tokens print once and
store as SHA-256; revocations are appended records), and per-key mint
quotas compose the gate's ledger-derived limits. Client keys authorize
ledger writes — they are not identity — and the submit path stays
unauthenticated: the live session id is the capability. This publishes
evidence, not trust: the issuer can still self-mint. A checker can submit
heads to the provider-neutral witness intake — or configure the witness to
poll this endpoint — but a private fork stays invisible until both views
reach one witness.

`cloudflare/` implements the atomic check API: issue one bounded challenge
session, consume one response set, and return a canonical signed admission
from R2. Issuance uses a bearer token and small D1 quota counters; completed
results are immutable JSON objects. The [check contract](docs/clankdar-checks-v1.md)
describes the API and operating limits.

The existing SQLite Durable Object actor/campaign implementation remains an
optional legacy application with its records and routes preserved. It is not
a prerequisite for issuing checks. See the [legacy guide](docs/clankdar-hosted-v1.md).
Private held-out pools, badges, and witness tools in this repository are reference
capabilities; their presence does not imply integration into the atomic API.

`clankdar-holdout-v1` covers issuer-private cells: `bun holdout gen` mints a
pool of published generator cells re-parameterized by secret labels, and gate
policies can name them as `h:family:tN`. The instance stream stays
unpublished, so solvers cannot pre-compute or look it up; checkers holding
the pool replay fully, everyone else gets `ok` with `replayable:false` —
signature and commitment verified, score issuer-claimed. Publishing the pool
later upgrades every historical held-out receipt to verifiable. A held-out
cell is the same puzzle family under a secret parameterization — a general
family solver still solves it.

An admission attests that one session produced K passing responses under one
policy in one window. It is not identity, liveness, or authority: challenges
can be delegated, and a verifier can always answer its own oracle, so relying
parties should issue their own challenges and treat foreign admissions as
issuer-claimed.

## Scoring and protocol boundaries

`clankdar-score-v2` compares the whole response using a family-specific answer
format. Signs, case in text tasks, digit boundaries, grid dimensions, and binary
leading zeroes are meaningful. The independent final-answer-block diagnostic
is separate from strict pass/fail and is not a capability estimate. Provider
errors are separate from wrong answers; token-limit truncations cannot pass.

The experimental commitment helper uses HMAC-SHA256 and requires a
verifier-secret key of 32–64 bytes. Its unambiguous transcript binds the scorer
version, challenge ID, answer format, and canonical answer. V1 public hashes
are not accepted: tiny answer spaces make them offline guessing oracles.

This helper is **not an admission protocol**. It does not authenticate an
issuer, bind a subject or scope, enforce expiry, rate-limit guesses, or persist
replay state. The suite's 32-bit Mulberry32 RNG is for public benchmarks, not
secret challenges. Do not use it to issue production admission puzzles.

Signed hashcash and standalone witness prototypes remain in
[hraness/valhalla](https://github.com/hraness/valhalla/tree/main/prototypes/botcaptcha)
and [prototypes/witness](https://github.com/hraness/valhalla/tree/main/prototypes/witness).
Their historical paths are intentionally preserved. Future signed-challenge
integration needs separate design, review, and live qualification.

## Site and delivery

```console
bun run check:site
python3 -m http.server 8765 --bind 127.0.0.1 --directory site/dist
bun run check:browser --channel chrome
```

The browser check owns a separate ephemeral loopback server and fresh browser
contexts. Use `bun x playwright install chromium` and omit `--channel chrome`
when using Playwright's Chromium instead of installed Chrome. Screenshots are
retained in a new ignored `results/visual-*` directory. The site uses the pinned
Hraness design kit's Paper palette, Lantern material, Nebula Sans and Instrument
Serif, plus the canonical shared footer with no newsletter or support profile.
Only the shared appearance controller runs in the browser. Challenges, tables,
and downloads remain usable without JavaScript.

`bun run check` runs strict TypeScript checking, tests, archived-report replay,
and the static build. `bun run check:browser` verifies responsive layout,
appearance controls, native answer disclosure, same-origin resources, links,
and browser errors. Deliver changes through a current-head pull request and
its passing checks. Generated `site/dist/` stays untracked; published pilot
artifacts are intentional source inputs, not private runtime results.

Verify the linked Hraness `clankdar` project and domain before deploying:

```console
vercel deploy --prod --scope hraness
```

Keep `.vercel/` private. `vercel.json` preserves the restrictive CSP and redirects
legacy `botcaptcha.dev` paths to `clankdar.com`. After deployment, verify routes,
canonical URLs, assets, archive hashes, redirects, and security headers. Retain
the existing project, domain, and previous production deployments for rollback.

`site/generate-icon.py` regenerates the icon PNGs; their hashes live in
`site/BRAND_ASSETS.md`.
