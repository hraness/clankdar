A Clankdar score counts exact matches. For the default puzzles, each answer is compared with a number that ALGAL's evaluator produced by running the puzzle itself, and no model reads the answer to decide whether it looks right.

## Trusting a score you did not produce

Suppose someone shows you that their agent passed a Clankdar check, or that one model release did better than another. You want to know whether the referee could have been talked into the result. Many evaluations use a second model as the judge. A judge model can be won over by a confident wrong answer, and it can change when its provider updates it, so two scores taken months apart may measure different things.

Clankdar removes the judgment step. It asks only questions with one correct answer, and it accepts that answer only in a fixed format. That works only if the correct answer comes from a source you can inspect, and ALGAL is that source.

## What ALGAL is

[ALGAL](https://algal.computer) describes itself as "a language and application VM for bounded agent programs". Part of it is a small expression language, `algal.expr.v1`, in which a program is plain JSON. The first item of each list names an operation, and the rest are its arguments:

```json
{ "contract": "algal.expr.v1", "program": ["add", 1, 2] }
```

The language has no network access, no files, no model calls, and no way to loop forever. Every evaluation runs under a work budget, which ALGAL calls fuel, so a program either finishes within its budget or fails with a typed error. ALGAL's specification says one evaluator, written in Rust, serves every runtime: it is linked directly into the native program and compiled to WebAssembly for Bun.

A puzzle is a short program plus its inputs, and the correct answer is whatever the official evaluator returns.

## How Clankdar uses it

Clankdar's default puzzle set is called `clankdar-algal-v1`. It has three puzzle types, each generated fresh from a seed:

- filter eight values against a cutoff, square the ones that remain, and add them up;
- run a three-value recurrence over ten inputs, modulo 97;
- apply twelve steps of a 4×4 matrix, modulo 997, then report one coordinate.

The agent sees the program, the inputs, a short description of each operation, the work budget, and the SHA-256 hash of the evaluator. It replies with a single integer.

### The reference answer comes from ALGAL's own evaluator

Clankdar does not rewrite ALGAL's operations in TypeScript to work out the answers, because a second implementation could quietly disagree with the first. It depends on ALGAL at an exact commit, loads ALGAL's own WebAssembly build of the Rust evaluator, and checks the bytes against a recorded hash before using them:

```text
reference = ALGAL evaluator(program, inputs, work budget)
pass      = the reply, read as an integer, equals reference
```

The evaluator is pinned in four ways: the ALGAL commit, the hash of the WebAssembly file, the language contract name, and a budget of 10,000 fuel units per evaluation. Clankdar's tests check that the WebAssembly module asks its host for nothing, so it cannot reach the network or the file system. They also check that puzzles generated across a spread of seeds give the same answer and fuel count through ALGAL's official loader. Changing the evaluator pin or the puzzle generator requires a new suite name, so an old score keeps its meaning.

The hosted service runs the same evaluator. Its copy of the WebAssembly file is checked against the same hash while the service is prepared, and a small adapter passes JSON in and out and manages the evaluator's memory. Clankdar caps requests and evaluator responses at 64 KiB each, and discards any evaluator instance that holds on to more than 16 MiB of memory after a run. The HTTP API accepts answers, never programs, so an agent cannot submit a program of its own or gain new evaluator abilities.

### What counts as a match

Scoring reads integers as integers. These cases come from Clankdar's tests against a reference answer of 34:

| Reply | Result |
| --- | --- |
| `34` or ` +034 ` | pass |
| `-34` | fail |
| `3 4` | fail |
| `answer: 34` | fail, flagged as the right number in the wrong format |

The flag lets a report separate a wrong answer from a right answer that ignored the format, without counting the second as a pass.

### The hosted default policy

On the hosted API, the default policy is `algal-floor-v1`: four puzzles drawn from the three types, three correct answers required, 180 seconds in total. Clankdar's docs call these task settings, not calibrated classes of model. The first accepted submission fixes the result, including a failed one. Each answered puzzle gets a receipt, Clankdar's signed record of that answer under the policy and deadline, and a complete check is stored as one signed record of its own.

## Rechecking a result later

The same program and inputs give the same number every time, on your laptop, in the benchmark runner, and on the hosted service, because all three run the same pinned evaluator.

Every puzzle comes from a suite name, a type, and a seed, so it can be rebuilt exactly. The hosted service keeps each fresh seed sealed until an answered puzzle produces its signed record. A missing or malformed answer stays a failure and gets no per-puzzle record. Verifying a record rebuilds the puzzle, runs the same ALGAL evaluator, and checks the response and the issuer's signature.

For local benchmark runs, Clankdar's replay tool follows the same rule:

```text
for each recorded answer:
  rebuild the puzzle from the suite name, type, and seed
  run the evaluator again to get the reference
  if the prompt or the reference differs from the recording, fail the whole run
```

For tool-using runs, replay also re-derives every recorded tool output and rescores the verdict. A checker that does not recognize the `clankdar-algal-v1` suite must reject its records instead of accepting a result it cannot replay.

To run the worked example, install Bun 1.3.14, clone the repository, and run:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run algal:example
```

It prints the program, the inputs, the budget, the answer, and the fuel used, and it calls no model. The site build runs the same example and fails if the program shown on clankdar.com drifts from the one that runs. [Introducing Clankdar](/blog/introducing-clankdar) walks through that example step by step.

## Where the referee stops

An exact referee makes the answer key trustworthy. It does not say who produced the answer. A Clankdar record shows what was submitted under which conditions; it does not show which model answered, and a puzzle can be solved with a script, careful reasoning, or help from someone else. It measures only these three kinds of computation, not general ability or safe behavior.

"Correct" here means what ALGAL's pinned evaluator returns under `algal.expr.v1`. Clankdar checks that it is running exactly that evaluator; it does not independently prove the evaluator right. The 16 MiB figure is a check on memory kept after a run, not a hard limit on peak use.

No model scores for the ALGAL puzzles have been published. The benchmark page's recorded scores come from Clankdar's earlier puzzle set, and publishing ALGAL scores waits on a separate calibration recorded under fixed conditions. Clankdar is in Preview: you can try puzzles in the browser or run it from source, and the hosted API is an experimental staging service open by invitation.
