# Clankdar’s Algal suite

Clankdar uses Algal’s bounded expression language to make executable puzzles.
Algal is the general language/runtime; Clankdar supplies fresh instances,
deadlines, typed answer scoring, and portable signed evidence.

The suite is **`clankdar-algal-v1`**, selected locally by `--suite algal`.
The hosted default is **`algal-floor-v1`**: four challenges drawn from
`algal:t1`, `algal:t2`, and `algal:t3`, three passes required, 180 seconds.
These are task settings, not calibrated model classes. There are no published
model measurements for this suite yet.

## One shared evaluator

The implementation executes Algal’s official `algal.expr.v1` Rust evaluator,
compiled to WebAssembly. It does not translate operations into a second
JavaScript implementation.

| Pin | Value |
| --- | --- |
| Upstream | [hraness/algal](https://github.com/hraness/algal/tree/723c35d3c60d1ef7b88437a9ddeaf6588a1814cf) |
| Revision | `723c35d3c60d1ef7b88437a9ddeaf6588a1814cf` |
| WASM SHA-256 | `7a8a821f80388a3ba257ac46c7e3d9668e25f77323b22603974d713df1a39fff` |
| Language contract | [algal.expr.v1](https://github.com/hraness/algal/blob/723c35d3c60d1ef7b88437a9ddeaf6588a1814cf/spec/v1/expr.md) |
| Clankdar work budget | 10,000 deterministic fuel units per evaluation |

Bun loads the pinned package artifact. The Worker imports a static copy whose
hash is checked during preparation. The small host adapter only transfers
JSON and manages the evaluator’s memory; the language semantics live upstream.
Changing the evaluator pin or frozen generator requires a new suite version.

## Run the worked example

From the repository root with Bun 1.3.14:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run algal:example
```

The inputs are `{"values":[1,3,2,5]}`. This is the actual program:

```json
["fold",
  ["map",
    ["filter", ["get", "values"], "x",
      ["gt", ["get", "x"], 2]],
    "x", ["mul", ["get", "x"], ["get", "x"]]],
  0, "sum", "item",
  ["add", ["get", "sum"], ["get", "item"]]]
```

`filter` keeps 3 and 5, `map` squares them, and `fold` adds 9 and 25.
The result is **34**, using **87 fuel units** in the pinned evaluator.
The command prints the expression, inputs, budget, answer, and measured fuel.
It makes no model calls. The site build executes this same example and rejects
code-display drift.

An expression is JSON data: the first item of each array names an operation.
`get` reads an input or lexical binding. `filter`, `map`, and `fold` bind names
for their bodies; they are bounded operations over finite lists. Literal
arrays inside expressions use `list` or `quote`. Inputs are ordinary JSON.

## Progressively composed tasks

| Cell | Structure |
| --- | --- |
| `algal:t1` | Filter eight fresh values, square the retained values, and sum them. |
| `algal:t2` | Update a coupled three-value recurrence over ten inputs, modulo 97. |
| `algal:t3` | Apply twelve transitions of a fresh 4×4 matrix, modulo 997, then select an output coordinate. |

Each prompt includes the program, inputs, operation definitions, fuel budget,
and evaluator hash. The respondent returns only the final integer. The
reference answer comes from executing that program. Submitted responses
cannot introduce a new program or gain evaluator capabilities.

Run a deterministic runner control:

```sh
bun bench --suite algal --adapter oracle --seeds 1-10 --out results/algal-control.jsonl
```

The oracle uses known answers and checks infrastructure; it is not model
performance. Real model adapters retain their dry-run default and explicit
request budget. Model scores need a separate recorded calibration under fixed
conditions; see the [benchmark guide](reference-tools.md).

## Bounds and evidence

Expressions have no network, filesystem, or model access. The pinned language
checks program shape and size and meters evaluation work. Clankdar additionally
bounds requests and evaluator responses to 64 KiB each and discards evaluator
instances that exceed 16 MiB of retained memory. That is a retained-memory
check, not a hard peak-allocation limit. Generated programs and inputs are
small and fixed by this suite; the HTTP API does not accept arbitrary programs.

Clankdar seals the fresh generator seed until an answered challenge produces
a receipt. Verification regenerates the recorded puzzle, executes the same
Algal evaluator, and checks the response and issuer signature. Missing or
malformed answers remain failures without a per-challenge receipt. A complete
check is still one `clankdar-gate-v1` signed admission stored as JSON in R2.
The [check API contract](clankdar-checks-v1.md) defines retries and storage.

## Compatibility and interpretation

The v2, frontier, agent, and legacy generators remain frozen. Their published
archives, scores, explicit policies, tickets, and receipts keep their original
meaning. Selecting `algal` never relabels an old benchmark as an Algal run.
Current TypeScript/Bun admission checking supports the new suite; older
checkers that do not recognize it must reject it rather than accept an
unreplayed result. This change makes no claim that the separate Valhalla Rust
admission-checker prototype supports the new suite.

A program can be solved with code, reasoning, or delegated help. The receipt
records task performance under an issuer’s conditions; it does not prove
which model answered, that a human was absent, or that the respondent should
receive authority. Keep application acceptance policy outside the primitive.
