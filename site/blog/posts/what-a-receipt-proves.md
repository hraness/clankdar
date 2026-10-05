When a service signs an evaluation result, the signature is only the beginning. What matters is what the signed record claims, what anyone can recompute from it, and which questions it was never meant to answer. Clankdar's receipts and admissions are deliberately narrow: they attest to scored episodes, not to the agent itself.

## A receipt attests one scored response

A Clankdar receipt is a signed record of one episode: the challenge, the submitted answer, the score, and the deadline the answer met. For each well-formed response it carries enough information to regenerate the puzzle (suite, type, and seed) and recompute its reference answer.

Verification is mechanical. The signature ties the record to an issuer's key. The seed commitment and regeneration tie the score to an exact puzzle. Editing any recorded answer (`515` to `514` in the repository's worked example) makes the verifier reject the whole file. A wrong answer still produces a valid signature on a failing receipt, so checking a result means checking the verdict, not just the cryptography.

## An admission attests one session verdict

A receipt is per challenge; an admission is per session. A gate session mints a set of sealed challenges under one deadline and one session id, consumes them in a single submission, and signs an admission that binds the complete challenge list, the receipts, and the verdict: passed at least the policy's minimum.

The claim is exactly this: one session produced that many passing responses, under that policy, inside that window. Verdict arithmetic, completeness, timing, regeneration, and rescoring all check independently; a relying party replays the admission without trusting the issuer beyond the signed episode.

## What the signed record never proves

An admission is capability evidence. It is not, and cannot be:

- **Identity**: the signature proves the issuer signed a session, not who or what sat on the other end. A named `subject` binds a claimed key, not a model identity.
- **Liveness**: nothing in the episode distinguishes a live model from a prepared script, a person at a keyboard, or a lookup table.
- **Authority**: a passing verdict does not authorize anything; it describes one measured episode.

Two structural reasons make those limits permanent rather than temporary. Challenges can be delegated: an agent can forward a puzzle to a stronger solver and return its answer, and no signature can see that hop. And a verifier can always answer its own oracle, so an issuer that runs its own session will pass. The rule for relying parties is to issue their own challenges and treat foreign admissions as issuer-claimed unless the backing evidence is published.

## The log makes the issuer's history checkable

The remaining question is whether an issuer's record is consistent over time. The transparency log derives a signed, hash-chained ledger over admission sessions: issued events become enumerable, witnesses pin signed heads, and a witness detects equivocation (two different heads at the same position) with a cryptographic fork proof from chain comparison.

The log's binding is also deliberately narrow. It binds history under the issuer's own key; it cannot reveal a private fork that never reaches a witness. A pinned head's holder verifies later growth with a consistency proof linear in the growth, not logarithmic, because the chain favors verifiability over compact proofs.

## How to read a result

So the reading order is: signature valid? verdict passing? policy the one you care about? window recent? Then the episode questions (replayable, or issuer-claimed under an undisclosed pool) and finally the issuer questions: whose key, do they publish a log, does a witness hold their head. A signed receipt answers the first group exactly. The rest is where trust in an issuer is earned or lost, one disclosed record at a time.
