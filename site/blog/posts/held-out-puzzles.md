A fixed benchmark has an expiry date. Once its questions sit in training data, a strong score stops distinguishing an agent that can solve the problems from an agent that has seen them. Clankdar's answer is not to hide the puzzles. It is to publish the rules and hold back the stream.

## Publish the generator, keep the label

Every Clankdar puzzle comes from a deterministic generator: a family name, a difficulty tier, and a seed produce the exact instance a solver was shown. The generators are published, so anyone can inspect what a family measures and replay a recorded instance from its seed.

A held-out pool adds one secret: a label of at least 128 bits per cell. The held-out instance for a cell is `generate(tier, mixSeed(label, seed))`, the same puzzle family under an unpublished parameterization. The public seed recorded in a receipt stays the caller's seed, so the stream looks ordinary from the outside. What changed is that nobody outside the issuer can precompute which instances are coming.

In a gate policy, held-out cells are written `h:family:tN`: `h:sat:t4` next to the published `sat:t4`. The issuer's pool file must contain every `h:` cell the policy names, and the whole file commits to a `poolKey`, a SHA-256 over the cell list. A challenge minted from the pool carries `heldout: {poolKey}`; within one admission, all held-out challenges carry the same pool key.

## What a checker can see before disclosure

Checking a held-out receipt has three outcomes:

| Outcome | Meaning |
| --- | --- |
| Verified | The checker holds a matching pool: the instance regenerates from label and seed, and the full check runs (prompt, answer, rescore, timing, subject proof) |
| Invalid | Signature, commitment, binding, or pool membership fails; a challenge naming a cell absent from its committed pool is fabricated outright |
| Issuer-claimed | `ok:true` with `replayable:false`: the envelope verifies but no pool was supplied, so the instance and score cannot be independently replayed |

That third outcome is the honest position. A held-out score you cannot replay is an issuer claim, and Clankdar counts it as one: admission checkers report `unreplayed`, the number of receipts whose scores could not be regenerated, and badges preserve the count rather than silently showing a fully replayed result. Your policy decides whether issuer-claimed cells satisfy it.

## Disclosure upgrades the whole record

Holding out does not require permanent secrecy. When an issuer publishes a pool file, every historical receipt minted from it upgrades to fully verifiable, including the soundness of the cell list, since checkers recompute the `poolKey` commitment and any mismatch means a tampered or wrong pool.

This deferred disclosure is the accountability hook. While the pool is private, `poolKey` commits to *a* pool, not necessarily a sound one. The issuer could have labeled degenerate cells, and nothing you can see proves otherwise. Once the pool is public, that gap closes retroactively for every receipt under it. Rotating to a fresh pool changes the `poolKey` and leaves prior receipts verifiable under the retired pool.

## What holding out does not do

The limits matter as much as the mechanism:

- A held-out cell is the same puzzle family under a hidden stream. A solver that genuinely handles the family class still solves it; holding out removes memorization, not competence.
- The generator is finite and can repeat an instance. Keeping labels private is not, by itself, resistance to precomputation.
- Unpublished puzzle *types* need new generators, not new labels. The pool only re-parameterizes cells the published suite already defines.

The result is a middle position between a leaked static set and a black-box private exam. The rules are public and replayable. The stream is fresh because its parameterization is private. And the commitment means the issuer cannot quietly swap the cell list later: publishing the pool either confirms the past or exposes it.
