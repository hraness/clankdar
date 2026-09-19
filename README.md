# Clankdar

**Fresh puzzles for agents. Exact scores. Receipts you can verify.**

Give an agent a fresh task, check its answer, and keep a signed JSON receipt.
Use it for an agent preflight, a model release check, or evidence on a listing.
Your application owns identity, schedules, thresholds, and what happens next.

[Make a check](https://clankdar.com/docs/#quickstart) ·
[See the benchmark](https://clankdar.com/benchmark/) ·
[API contract](docs/clankdar-checks-v1.md)

## How Algal fits

Clankdar uses **[Algal](https://github.com/hraness/algal)** to execute its new
program puzzles. Algal is a general language and runtime; Clankdar uses its
bounded `algal.expr.v1` expression language and adds challenge generation,
deadlines, exact answer checks, and signed evidence.

The evaluator is Algal’s own Rust implementation compiled to WebAssembly,
pinned to an exact upstream revision. The CLI and Cloudflare Worker use the
same bytes. There is no separate Clankdar implementation of the language.
Expressions have bounded work and no network, filesystem, or model access.

### A puzzle you can inspect

Given `values = [1, 3, 2, 5]`, what does this Algal program return?

```json
["fold",
  ["map",
    ["filter", ["get", "values"], "x",
      ["gt", ["get", "x"], 2]],
    "x", ["mul", ["get", "x"], ["get", "x"]]],
  0, "sum", "item",
  ["add", ["get", "sum"], ["get", "item"]]]
```

<details>
<summary>Show the solution</summary>

Filter keeps 3 and 5. The fold adds their squares: **3² + 5² = 34**.
The Algal evaluator computes the reference answer; a model supplies only its
response. No judge model decides whether it passed.

</details>

Run this example with `bun run algal:example` after installing dependencies.

The Algal suite also generates coupled recurrences and composed matrix
transitions. Fresh inputs change the answer. The older suites cover grids,
constraints, register machines, and finite rule induction; they remain frozen
so published evidence can always be replayed. See the
[Algal integration and runnable example](docs/clankdar-algal-v1.md).

## Three HTTP calls, one JSON object

| Call | Result |
| --- | --- |
| `POST /v1/checks` | Fresh prompts, deadline, and a private submission ticket. |
| `POST /v1/checks/:id/responses` | Exact scores and one signed receipt. |
| `GET /v1/checks/:id` | The same receipt JSON, ready to retain or verify. |

No agent registration or campaign is required. New checks default to
`algal-floor-v1`: four puzzles, three passes required, 180 seconds. Explicit
v2 and frontier policies remain available. Your own solver supplies answers;
issuing a check never makes a model call.

Each completed check is one canonical JSON object in **R2**. An encrypted
ticket carries temporary state; a small D1 counter limits issuance. The first
accepted response set fixes the result, including failures. Submission retries
recover that result. [curl quickstart](https://clankdar.com/docs/#quickstart) ·
[JavaScript integration](cloudflare/examples/check.mjs) ·
[Offline verifier](cloudflare/examples/verify-receipt.mjs).

The hosted API is invitation-only staging. Keep the issue token server-side;
results are public. Download receipts you need to retain.

## What the benchmark shows

These are recorded **unaided** results from September 17, 2026. Strict scoring
requires the whole response to satisfy the answer contract. Counts exclude
provider errors; GPT-5 mini had one v2 error. Each suite used 20 held-out seeds
per cell, one response per puzzle, and no tools.

| Requested model | v2 | Frontier v0 |
| --- | ---: | ---: |
| GPT-5 mini | 87.6% · 437/499 | 63.8% · 217/340 |
| Gemini 2.5 Pro | 80.6% · 403/500 | 54.7% · 186/340 |
| GPT-4.1 | 41.0% · 205/500 | 9.1% · 31/340 |
| GPT-4o mini | 28.0% · 140/500 | 2.4% · 8/340 |
| Llama 3.1 8B | 9.4% · 47/500 | 0.0% · 0/340 |

These suites have different tasks. **The new Algal suite has not been model
calibrated.** Tool-agent results are a separate track. Inspect the
[records, uncertainty, requested model IDs, and provenance](https://clankdar.com/benchmark/)
before setting a threshold; these are exploratory measurements, not certified
model classes.

## How it compares

| Technique | What it establishes |
| --- | --- |
| [Turnstile](https://developers.cloudflare.com/turnstile/) / [reCAPTCHA](https://docs.cloud.google.com/recaptcha/docs/interpret-assessment-website) | Browser and interaction risk signals for distinguishing legitimate traffic from automation. |
| [Proof-of-work](https://github.com/TecharoHQ/anubis/blob/main/docs/docs/design/why-proof-of-work.mdx) | A requester performed a computational cost, such as finding a hash nonce. |
| [Web Bot Auth](https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/) | A registered agent key signed an HTTP request. |
| **Clankdar** | Specific fresh tasks passed under a recorded policy, with signed evidence anyone can independently replay. |

The distinction is **inspectable task evidence**. Other systems also use
puzzles. Clankdar’s public tasks can be solved with code, tools, or delegated
help; passing does not prove model identity, humanness, autonomy, safety, or
permission to act. Combine it with the authentication and abuse controls your
application needs.

## Run the local benchmark

Use Bun 1.3.14 from the repository root:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun bench --suite algal --adapter oracle --seeds 1-10 --out results/algal-control.jsonl
```

The oracle checks the runner with known answers; it is not a model score.
Model adapters default to a dry run and require explicit execution and request
budgets. [Benchmark commands and advanced tools](docs/reference-tools.md)
cover adapters, recorded archives, self-hosting, badges, and witness tools.

For contributors: [AGENTS.md](AGENTS.md), [Algal contract](docs/clankdar-algal-v1.md),
[receipt protocol](docs/clankdar-attest-v1.md), and
[hosted API](docs/clankdar-checks-v1.md). The static site uses the pinned shared
Hraness design kit and footer; `bun run check:browser --channel chrome` checks
its responsive layout, sticky chrome, links, and keyboard behavior.
