# Clankdar

Clankdar checks what your agent can solve. It issues fresh puzzles, scores each answer exactly, and signs a receipt your application can verify.

**[Try a puzzle in your browser](https://clankdar.com/#try).** No install or signup. [Docs](https://clankdar.com/docs/) · [Model benchmark](https://clankdar.com/benchmark/)

## Make your first receipt

With [Bun 1.3.14](https://bun.sh/docs/installation):

```sh
git clone https://github.com/hraness/clankdar.git
cd clankdar
bun install --frozen-lockfile --ignore-scripts
bun run try
```

The demo creates four fresh Algal puzzles, solves them with an included script, signs a receipt, and independently verifies it. It saves `receipt.json` and `verification.json` in a new `results/try-…/` directory and prints a verification command.

It needs no credentials and calls no model. A script answers the puzzles and a temporary key signs the receipt, so the result only shows that the flow works. It does not measure a model, and the receipt is not from the hosted service.

To test your own solver:

```sh
bun run try --solver ./my-solver.mjs
```

Export `solve(challenges, signal)` from that module. Return an object that maps each `challengeId` you received to an answer string. The callback receives only public challenges; you own its code, provider choice, request budget, and costs. [See the solver example](https://clankdar.com/docs/#own-solver).

## Add it to your application

Use checks for agent preflight, release comparisons, or evidence on a listing. Your app handles identity, scheduling, and the decision to accept a result.

The hosted API is an experimental staging service, open by invitation. [Request hosted access](https://github.com/hraness/clankdar/issues/new?title=Hosted%20API%20access), keep the token on your server, and use ordinary HTTP or the small [Node 22+/Bun helper](cloudflare/examples/check.mjs):

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

The default `algal-floor-v1` policy requires three of four answers within 180 seconds. The first accepted submission fixes the result, including a failed one; any later valid retry with the same ticket returns that first result. Keep your token and each check’s ticket private. Any `context` you send and the submitted answers become public. Receipts aren’t deleted automatically, but this experimental service doesn’t promise to keep them, so download any receipt you need. See the [API contract and staging limits](docs/clankdar-checks-v1.md).

## What the evidence means

Clankdar’s default puzzles are small programs in [Algal’s expression language](docs/clankdar-algal-v1.md). Clankdar generates fresh inputs for each puzzle, and Algal’s official evaluator, pinned by commit and hash, computes the reference answer. A receipt records submitted answers under a policy and deadline. It doesn’t show which model answered, and a puzzle can be solved with code or handed to someone else; see [what a check establishes](https://clankdar.com/docs/#security).

See the [model benchmark](https://clankdar.com/benchmark/) for recorded scores and test conditions, or [compare approaches](https://clankdar.com/docs/#comparison).

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

`oracle` checks the runner with known answers. Model calls default to a dry run and require explicit execution and request budgets. The [reference tools guide](docs/reference-tools.md) covers adapters, run settings, and result verification.

For contributors: `bun run check` runs the typechecks, tests, and site build. See [AGENTS.md](AGENTS.md) for browser validation and delivery requirements.
