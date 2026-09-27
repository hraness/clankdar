---
pretty_name: Clankdar benchmark reports
tags:
  - benchmark
  - evaluation
  - agents
---

# Clankdar benchmark reports

Published calibration reports for [Clankdar](https://clankdar.com/benchmark/), which generates puzzles and scores answers with deterministic rules. Use these files to inspect recorded counts, model aliases, excluded cells, and the exact suite and scorer versions behind the published results.

## Files and interpretation

Each folder under `data/` preserves one public archive's `manifest.json` and `report.json`:

- `pilot-v0`: the legacy pilot. Its provenance and scoring limits remain part of the report.
- `v2-calibration-0`: calibration on the earlier `clankdar-suite-v2` puzzle set.
- `frontier-v0`: unaided responses on the frontier puzzle set.
- `agent-v0`: tool use with a fixed interaction budget.

Compare runs only when the suite, scorer, prompt, seed policy, and interaction budget match. Keep the tool-agent results separate from unaided results. Model names are requested aliases; they do not establish the identity of the system that answered. These historical scores do not describe the current ALGAL puzzle set.

The reports contain aggregate scores and source references. Raw response archives remain linked from the [original benchmark page](https://clankdar.com/benchmark/). This dataset does not contain those responses or signed check records. A report alone cannot independently establish the correctness of every recorded score.

## Provenance and updates

The [source repository](https://github.com/hraness/clankdar) owns these files. `export-manifest.json` records the source commit and SHA-256 of each file. Existing version folders remain frozen; new public runs receive new folders. Corrections receive a new version with an explanation linking the affected archive.

## Rights

No additional license is granted by this mirror. Consult the source repository and the original artifact's terms before redistribution. Publication of this candidate requires the owner to resolve the dataset license.
