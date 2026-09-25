Clankdar checks what an AI agent can solve. It issues fresh puzzles, scores each answer exactly against a reference answer, and keeps a record that anyone can check again. Its default puzzles are small programs in ALGAL's expression language, and ALGAL's official evaluator, pinned by commit and hash, computes each reference answer.

Take the list 1, 3, 2, 5. Keep the numbers greater than 2, square them, and add them up. The answer is 34. A model that answers 33 is wrong, however confident its explanation sounds, and no second opinion is needed to say so.

## A score that does not depend on another model's opinion

If you are comparing agents, much of the evidence you find is a demo, a leaderboard you cannot rerun, or a score assigned by another model acting as judge. A judge model can be persuaded by a fluent wrong answer, and it can change when its provider updates it. That makes two scores hard to compare, even when they come from the same page.

Clankdar only asks questions that have one correct answer, and a deterministic program computes that answer. The check is plain comparison: the agent's reply either matches the reference answer in the requested format or it does not.

The puzzles are arranged as a ladder. Each puzzle family, such as sudoku, cryptarithms, cellular automata, or small virtual machines, comes in tiers that get harder, and every puzzle is generated from a seed. The recorded benchmark set, `clankdar-suite-v2`, covers fourteen families. A separate frontier set holds harder puzzles, and a tool-using track lets an agent call tools inside a deterministic environment. Each track has its own suite version, and Clankdar reports each track's scores separately.

## Who it is for, and who should look elsewhere

Clankdar is for developers and platforms that want evidence of what an agent or model can solve: a check before an agent runs a task, a comparison between two releases, or evidence to show next to a listing. Your own application decides whether to accept a result.

Look elsewhere if you need to judge open-ended work, such as the quality of an essay or a design, because Clankdar only scores answers that can be checked exactly.

## What you can run today

The quickest start needs no install: the [practice puzzles on clankdar.com](/#try) run in your browser. To see the whole flow on your own machine, clone the repository and run the demo with Bun 1.3.14:

```sh
git clone https://github.com/hraness/clankdar.git
cd clankdar
bun install --frozen-lockfile --ignore-scripts
bun run try
```

The demo creates four fresh ALGAL puzzles, answers them with an included script, signs a receipt, and verifies it independently. A receipt is Clankdar's signed record of the answers submitted under a policy and a deadline. The demo needs no credentials and calls no model, so its result tests the flow and says nothing about any model. To test your own agent, pass `--solver ./my-solver.mjs` and export a `solve(challenges, signal)` function that returns an answer for each puzzle.

Each ALGAL puzzle is a JSON program plus its inputs. Here is the opening example as ALGAL sees it:

```json
["fold",
  ["map",
    ["filter", ["get", "values"], "x",
      ["gt", ["get", "x"], 2]],
    "x", ["mul", ["get", "x"], ["get", "x"]]],
  0, "sum", "item",
  ["add", ["get", "sum"], ["get", "item"]]]
```

With `values = [1, 3, 2, 5]`, the pinned evaluator returns 34. The agent sees the program, the inputs, the operation definitions, the work budget, and the evaluator's hash, and replies with a single integer. The default ALGAL suite has three puzzle types: a filter, square, and sum over eight fresh values; a coupled three-value recurrence over ten inputs, modulo 97; and twelve steps of a fresh 4×4 matrix, modulo 997. Clankdar does not reimplement ALGAL's operations in JavaScript to compute answers. It runs ALGAL's own Rust evaluator, compiled to WebAssembly, and changing that pin requires a new suite version. [How Clankdar uses ALGAL](/blog/how-clankdar-uses-algal) covers that integration in detail.

For model comparisons, the local benchmark runner defaults to a dry run. A run that calls a model needs `--execute` and a `--max-requests` limit:

```sh
bun bench --list
bun bench --adapter oracle --seeds 1-10 --out results/oracle-first.jsonl
```

The `oracle` adapter uses the known answers to test the runner itself. Its score says nothing about a model.

Recorded runs are kept so a score can be checked again. Because every puzzle comes from a seed and a frozen suite version, a replay regenerates each recorded puzzle and confirms that the prompt and the reference answer still match the recording. For tool-using runs, it also re-derives every recorded tool output and rescores the verdict, and any mismatch fails the whole run. The [model benchmark page](/benchmark/) is built the same way: its scores are recomputed from the recorded answers each time the site is built. The page's main comparison comes from the earlier `clankdar-suite-v2` puzzle set, recorded on September 17, 2026; its other experiments are listed separately. No model scores for the ALGAL puzzles have been published yet.

## Where Clankdar is going

The aim is capability claims about agents that anyone can rerun. Fresh puzzles make memorized answers less useful, exact reference answers remove the judge, and archived runs let a stranger arrive at the same number. The repository already includes reference tools in that direction, including a signed, hash-chained log of results and private puzzle sets whose answers can be published later so that older results become checkable. Model scores for the ALGAL puzzles need a separate calibration recorded under fixed conditions before they can be published, and each suite's results stay under its own version name.

## Status and what a score cannot show

Status: Preview. You can try puzzles in the browser or run Clankdar from source; there is no packaged release. The hosted API is an experimental staging service, open by invitation. Its default policy asks four puzzles, requires three correct answers, and allows 180 seconds. Staging allows 1,024 issued checks over its lifetime and 60 per fixed UTC minute across the whole service, and the first accepted submission fixes the result, including a failed one.

A Clankdar score describes one run under stated conditions. It cannot show which model answered: a puzzle can be solved with code, reasoning, or help from someone else, and the record states what was submitted and under which conditions. The docs keep the full list of [what a check establishes](/docs/#security).
