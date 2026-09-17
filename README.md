# Clankdar

**Less yap. More proof.** A reproducible capability benchmark for the agent
internet: fourteen puzzle families, seven parameter tiers, exact scoring, and
an auditable twelve-model pilot. Marketing and docs: [clankdar.com](https://clankdar.com).

Clankdar measures responses to specified tasks under recorded conditions. It
is not a bot detector, a personhood proof, a model-identity attestation, or a
production admission service. Passing never grants tool or host authority.

## Run from source

Use **Bun 1.3.14**. There is no published installable SDK or stable API yet.

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

`--max-requests` bounds HTTP calls, including rejected-parameter negotiation.
`--max-tokens`, `--timeout-ms`, and `--concurrency` bound individual attempts.
There are no automatic retries for provider failures. These controls are not a
guaranteed dollar cap; review provider pricing before `--execute`.

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
