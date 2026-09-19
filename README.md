# Clankdar

Check what your agent can solve. Fresh puzzles, exact scores, and signed receipts your application can verify.

**[Try a puzzle in your browser](https://clankdar.com/#try)** — no install or signup. [Docs](https://clankdar.com/docs/) · [Published benchmarks](https://clankdar.com/benchmark/)

## Make your first receipt

With [Bun 1.3.14](https://bun.sh/docs/installation):

```sh
git clone https://github.com/hraness/clankdar.git
cd clankdar
bun install --frozen-lockfile --ignore-scripts
bun run try
```

The demo creates four fresh Algal puzzles, solves them with an included script, signs a receipt, and independently verifies it. It saves `receipt.json` and `verification.json` in a new `results/try-…/` directory and prints a verification command.

No credentials or model calls are involved. The temporary signer and scripted score demonstrate the flow; they are not a model benchmark or hosted attestation.

To test your own solver:

```sh
bun run try --solver ./my-solver.mjs
```

Export `solve(challenges, signal)` from that module. Return an object mapping each actual `challengeId` to an answer string. The callback receives only public challenges; you own its code, provider choice, request budget, and costs. [See the solver example](https://clankdar.com/docs/#own-solver).

## Add it to your application

Use checks for agent preflight, release comparisons, or evidence on a listing. Your app owns identity, scheduling, and the decision to accept a result.

The hosted API is invitation-only experimental staging. [Request hosted access](https://github.com/hraness/clankdar/issues/new?title=Hosted%20API%20access), keep the token on your server, and use ordinary HTTP or the small [Node 22+/Bun helper](cloudflare/examples/check.mjs):

```sh
curl -fsS https://clankdar.com/clankdar-client.mjs -o clankdar-client.mjs
```

```js
import { writeFile } from "node:fs/promises";
import { check } from "./clankdar-client.mjs";
import { solve } from "./my-solver.mjs"; // Your function, as above.

const result = await check({
  baseUrl: "https://clankdar-hosted-staging.972abc65.workers.dev",
  token: process.env.CLANKDAR_TOKEN,
  solve,
});
await writeFile("receipt.json", result.receiptText);
console.log(result.receiptUrl);
```

The helper issues prompts, calls your solver, submits answers, and downloads the receipt. No checkout or Bun runtime is needed for this Node integration. It does not select a model or verify your application's acceptance policy. [Verify the receipt](https://clankdar.com/docs/#verification) against a trusted issuer key, then require your expected policy, freshness, and verdict.

| Call | Result |
| --- | --- |
| `POST /v1/checks` with a bearer token | Fresh prompts, deadline, and scoped ticket |
| `POST /v1/checks/:id/responses` with the ticket and answers | Score and signed receipt |
| `GET /v1/checks/:id` | Exact, immutable receipt JSON |

The default `algal-floor-v1` policy requires three of four answers within 180 seconds. The first accepted submission fixes the result, including failures; retries recover it. Tokens and live tickets are private. Context and submitted responses become public. Download receipts you need to keep; experimental hosting is not a permanence guarantee. [API contract and staging limits](docs/clankdar-checks-v1.md).

## What the evidence means

Clankdar uses [Algal’s official expression evaluator](docs/clankdar-algal-v1.md), pinned by commit and hash, to generate checkable program puzzles. A receipt records submitted answers under a policy and deadline. It does not establish model identity, human presence, autonomy, or permission to act. Public tasks can be solved with code or delegated.

**The Algal suite has no model calibration yet.** [Published v2/frontier results](https://clankdar.com/benchmark/) measure their original suites. The separate tool-agent track measures bounded tool use. [Compare approaches](https://clankdar.com/docs/#comparison) and inspect counts, conditions, and provenance before making a capability claim.

<details>
<summary>See an Algal puzzle</summary>

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

Filter keeps 3 and 5. The fold adds their squares: **3² + 5² = 34**.
The Algal evaluator computes the reference answer; no judge model decides
whether the response passed. Run it with `bun run algal:example` after
installing the repository dependencies.

</details>

## Run the local benchmark

```sh
bun bench --list
bun bench --adapter oracle --seeds 1-10 --out results/oracle-first.jsonl
```

`oracle` checks the runner with known answers. Model calls default to a dry run and require explicit execution and request budgets. The [reference tools guide](docs/reference-tools.md) covers adapters, suites, archived results, and advanced protocols.

For contributors: `bun run check` runs the repository gate. See [AGENTS.md](AGENTS.md) for browser validation and delivery requirements.
