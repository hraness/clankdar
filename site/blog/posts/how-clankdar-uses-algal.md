A score is easier to check when you can compute the answer yourself. Clankdar uses [ALGAL](https://algal.computer) to calculate the reference answer for its default puzzles. It records enough information to rebuild each puzzle and repeat the calculation, so someone reading a result can check how it was scored.

## Start with an answer you can compute

Consider the values `[1, 3, 2, 5]`. Keep the values greater than two, square them, and add the squares. The retained values are three and five, so the answer is **34**.

ALGAL expresses this calculation as a small program. Its expression language represents operations as JSON arrays: `["add", 1, 2]` adds one and two. Longer programs combine operations such as filtering a list, transforming its values, and adding them together.

Clankdar sends the program and its inputs to ALGAL's evaluator, the program that carries out those operations. The number it returns is the reference answer. Clankdar compares the agent's response with that number using a fixed scoring rule.

This makes the question precise: did the response give the integer the program computes? Evaluating an essay or an open-ended plan requires a different scoring method.

## Separate a wrong answer from a formatting mistake

For the example above, these responses have different outcomes:

| Reply | Result |
| --- | --- |
| `34` or ` +034 ` | Pass |
| `-34` | Fail |
| `3 4` | Fail |
| `answer: 34` | Fail: correct number, wrong format |

The integer scorer accepts a sign and surrounding whitespace, but the complete response must be an integer. It can report a formatting mistake separately without counting it as a pass. That distinction helps you see whether an agent failed the calculation or the instruction to return only the answer.

## Change the inputs and preserve the rules

Clankdar's default puzzle set, `clankdar-algal-v1`, generates three kinds of program:

- Filter eight values against a cutoff, square the retained values, and add them.
- Update three linked values over ten inputs, using arithmetic modulo 97.
- Apply twelve steps of a 4×4 matrix, using arithmetic modulo 997, and report one output coordinate.

Each prompt includes the program, inputs, operation definitions, and work budget. An agent returns the final integer. A fresh seed chooses the puzzle's inputs; the suite name identifies the generation and evaluation rules.

The seed matters when checking a recorded result. With the same suite, puzzle type, and seed, a verifier can reconstruct exactly what the agent was asked. Replaying a different puzzle would tell you nothing about the recorded answer.

## Keep the evaluator fixed

Reproducible scoring also depends on the program that computes the reference. Clankdar uses ALGAL's official evaluator at a fixed source revision and checks its WebAssembly file against a recorded SHA-256 hash. The local tools and hosted service use the same evaluator.

The language contract and evaluation budget are fixed too. Each evaluation has 10,000 units of work, called fuel. It either finishes within that budget or returns an error. These expressions have no network, filesystem, or model access.

Changing the evaluator or puzzle generator requires a new suite version. An earlier result keeps the rules under which it was scored. Pinning those rules makes the calculation repeatable; the evaluator's specification and implementation remain available for inspection in the [suite reference](https://github.com/hraness/clankdar/blob/main/docs/clankdar-algal-v1.md).

## Recompute a recorded score

A Clankdar receipt is a signed record of the submitted answers, policy, deadline, and result. For each well-formed answer, it contains the information needed to regenerate the puzzle and compute its reference answer again. Missing or malformed answers count as failures without a per-puzzle receipt.

Verification checks both the answers and the signature. The signature ties the recorded result to an issuer's key; your application chooses which issuer to trust. A valid signature can accompany a failing score, so accepting a result also requires checking its verdict, policy, and age. The [verification guide](/docs/#verification) shows the command and the checks your application must make.

The receipt establishes performance on these puzzles. It doesn't identify the model that answered them. For a hands-on example of the calculation, follow the [worked example](https://github.com/hraness/clankdar/blob/main/docs/clankdar-algal-v1.md#run-the-worked-example): the same evaluator returns 34 for the values above.
