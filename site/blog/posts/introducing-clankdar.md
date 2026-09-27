Clankdar tests AI agents on fresh puzzles that each have one correct answer, computed by a program. A reply passes only if it matches that answer, so no second model grades the work, and anyone with a recorded run can regenerate the puzzles and arrive at the same score. Clankdar is in Preview: you can try it in the browser or run it from source.

Here is the kind of question it asks. Take the list 1, 3, 2, 5, keep the numbers greater than 2, square them, and add them up. The answer is 34. A model that answers 33 is wrong however confident its explanation sounds, and no second opinion is needed to say so.

## Why Clankdar uses computed answers instead of a judge model

When you compare agents, much of the evidence is a demo, a leaderboard you cannot rerun, or a score that another model assigned as judge. A judge model can be persuaded by a fluent wrong answer, and its provider can update it, so two scores on the same page may not measure the same thing.

Clankdar asks only questions with one correct answer, and a deterministic program computes that answer. The agent's reply either matches it in the requested format or fails.

Puzzles come in families, such as sudoku, cryptarithms, cellular automata, and small virtual machines, and each family has tiers that get harder. Every puzzle is generated from a seed. The recorded benchmark set, `clankdar-suite-v2`, covers fourteen families. A separate frontier set holds harder puzzles, and a tool-using track lets an agent call tools inside a deterministic environment. Each track has its own suite version, and Clankdar reports each track's scores separately.

## Who Clankdar is for

Clankdar suits developers and platforms that want evidence of what an agent or model can solve: a check before an agent runs a task, a comparison between two releases, or a result to show next to a listing. Your own application decides whether to accept a result.

If you need to judge open-ended work, such as the quality of an essay or a design, use a different tool. Clankdar scores only answers that can be checked by exact comparison.

## Try a puzzle or run the demo

The [practice puzzles on clankdar.com](/#try) run in your browser with nothing to install. To see the whole flow on your own machine, clone the repository and run the demo with Bun 1.3.14:

```sh
git clone https://github.com/hraness/clankdar.git
cd clankdar
bun install --frozen-lockfile --ignore-scripts
bun run try
```

The demo creates four fresh ALGAL puzzles, answers them with an included script, signs a receipt, and verifies it independently. A receipt is Clankdar's signed record of the answers submitted under a policy and a deadline. The demo needs no credentials and calls no model, so its result tests the flow and says nothing about any model. To test your own agent, pass `--solver ./my-solver.mjs` and export a `solve(challenges, signal)` function that returns an answer for each puzzle.

## What an ALGAL puzzle looks like

Clankdar's default puzzles are written in ALGAL, a small language whose programs are JSON data. Each puzzle is a program plus its inputs. Here is the opening example as ALGAL sees it:

```json
["fold",
  ["map",
    ["filter", ["get", "values"], "x",
      ["gt", ["get", "x"], 2]],
    "x", ["mul", ["get", "x"], ["get", "x"]]],
  0, "sum", "item",
  ["add", ["get", "sum"], ["get", "item"]]]
```

With `values = [1, 3, 2, 5]`, the pinned evaluator returns 34. The agent sees the program, the inputs, the operation definitions, the work budget, and the evaluator's hash, and replies with a single integer. The default ALGAL suite has three puzzle types:

- a filter, square, and sum over eight fresh values;
- a coupled three-value recurrence over ten inputs, modulo 97;
- twelve steps of a fresh 4×4 matrix, modulo 997.

Clankdar does not reimplement ALGAL's operations in JavaScript to compute answers. It runs ALGAL's own Rust evaluator, compiled to WebAssembly and pinned by commit and hash, and changing that pin requires a new suite version. [How Clankdar uses ALGAL](/blog/how-clankdar-uses-algal) covers the integration in detail.

## Benchmark a model locally

The local benchmark runner defaults to a dry run. A run that calls a model needs `--execute` and a `--max-requests` limit:

```sh
bun bench --list
bun bench --adapter oracle --seeds 1-10 --out results/oracle-first.jsonl
```

The `oracle` adapter uses the known answers to test the runner itself, so its score says nothing about a model.

## How a recorded score is checked again

Because every puzzle comes from a seed and a frozen suite version, a replay regenerates each recorded puzzle and confirms that the prompt and the reference answer still match the recording. For tool-using runs, it also re-derives every recorded tool output and rescores the verdict. Any mismatch fails the whole run.

The [model benchmark page](/benchmark/) works the same way: the site build recomputes its scores from the recorded answers. The page's main comparison comes from the earlier `clankdar-suite-v2` puzzle set, recorded on September 17, 2026, and its other experiments are listed separately. No model scores for the ALGAL puzzles have been published yet. They need a separate calibration, recorded under fixed conditions, before they can be, and each suite's results stay under its own version name.

## What Clankdar is building toward

The goal is capability claims about agents that anyone can rerun. Fresh puzzles make memorized answers less useful, computed answers remove the judge, and archived runs let a stranger reach the same number. The repository already includes reference tools in that direction, including a signed, hash-chained log of results and private puzzle sets whose answers can be published later so that older results become checkable.

## Limits of the hosted API and of a score

There is no packaged release. The hosted API is an experimental staging service, open by invitation. Its default policy asks four puzzles, requires three correct answers, and allows 180 seconds. Staging allows 1,024 issued checks over its lifetime and 60 per fixed UTC minute across the whole service, and the first accepted submission fixes the result, including a failed one.

A Clankdar score describes one run under stated conditions. It doesn't show which model answered: a puzzle can be solved with code, reasoning, or help from someone else, and the record states only what was submitted and under which conditions. The docs keep the full list of [what a check establishes](/docs/#security), and ALGAL's own site lists [the other products built on ALGAL](https://algal.computer/blog/built-on-algal/).
