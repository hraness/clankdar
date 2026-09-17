# Botcaptcha

Signed, scoped challenge admission for agent networks — proof-of-work, witness
programs, and a graded capability ladder — plus the public benchmark that
measures which models reach which rung. This repository holds the
[botcaptcha.dev](https://botcaptcha.dev) marketing and documentation site; the
protocol prototypes live in
[hraness/valhalla](https://github.com/hraness/valhalla/tree/main/prototypes/botcaptcha)
and
[hraness/valhalla](https://github.com/hraness/valhalla/tree/main/prototypes/witness)
pending extraction.

## Benchmark

The capability ladder lives in `ladder/`: fourteen seeded puzzle families
across tiers 0–6, deterministic generation, answer normalization, and
answer-commitment hashing (`sha256(domain ‖ challenge_id ‖ norm(answer))`) for
admission mode. `bench/` runs adapters against a suite slice and writes one
JSONL row per instance plus a summary record.

```console
bun test                                        # determinism + answer verification
bun bench --list                                # families and their tiers
bun bench --adapter oracle --seeds 1-64 --out results/oracle.jsonl
bun bench --adapter openai:gpt-4o-mini --tiers 0-3 --seeds 1-32
OPENAI_BASE_URL=http://localhost:8000/v1 bun bench --adapter openai:local-model
```

Adapters: `oracle` (upper bound — returns the canonical answer), `echo`
(lower bound — returns the prompt), and `openai:<model>` (any
OpenAI-compatible chat endpoint; key from `OPENAI_API_KEY` or
`BOTCAPTCHA_API_KEY`, base URL from `OPENAI_BASE_URL` or
`BOTCAPTCHA_BASE_URL`). Tier labels are hypotheses until a published
calibration run verifies them; results land in `results/` (gitignored).

## Preview

```console
bun install --frozen-lockfile --ignore-scripts
bun run build:site
python3 -m http.server 8765 --bind 127.0.0.1 --directory site/dist
```

Open http://127.0.0.1:8765. The site uses the pinned `@hraness/design-kit`
Paper palette, Lantern material, marketing texture, Nebula Sans and Instrument
Serif fonts. The shared appearance controller provides Light, Dark and System
from the final header control. Build output retains asset licenses and exact
stylesheet hashes in `design/source.json`. The pinned shared footer renders
without a newsletter form or client runtime; `bun run check:site` checks that
boundary and builds all pages.

`vercel.json` builds `site/dist/` as the static output and sets restrictive
content security headers. Deploy from the repository root to the Hraness
`botcaptcha` project after reviewing the changes and checking every page at
desktop and mobile sizes:

```console
vercel link --project botcaptcha --scope hraness
vercel deploy --prod --scope hraness
```

Keep `.vercel/` private and untracked. Verify that https://botcaptcha.dev
returns the new pages and that CSS, fonts, navigation, and HTTPS work after
deployment. Use Vercel's retained production deployments to roll back; never
delete the domain or recreate the project to repair a page.

`site/generate-icon.py` regenerates `site/icon.png` and `site/apple-icon.png`;
record their new SHA-256 digests in `site/BRAND_ASSETS.md`.
