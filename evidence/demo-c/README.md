# Demonstration C — First-order improvement

> DETERMINISTIC FIXTURE EVALUATION — executable validators on synthetic change-review cases; no model was run
> ISOLATION MODE: enforced
> Both candidates were written by the same author who wrote the held-out cases. This shows the machinery separates a flawed candidate from a sound one; it is not evidence about a model's ability to generalize.

The incumbent change-review skill never compares a contract before and after a change, so it approves breaking changes. Those failures are observed on review work, a candidate adds an interface-compatibility step, and the release gate judges it on held-out cases the author cannot see.
The first candidate catches breaks but also blocks safe additions, and is rejected by a hard gate. Its revision is accepted on a different held-out set, runs in a bounded canary on fresh cases, and is retained.

## What was checked

| Claim | Observed | Result |
|---|---|---|
| An observed failure is recorded with what actually went wrong | 13 verified failures in 40 reviews under release r1 (accuracy 68%): type_changed×3, field_removed×4, field_renamed×3, required_added×2, enum_value_removed×1 | held |
| The first candidate is an executable change to a skill, judged on held-out cases against a frozen protocol | adds execution.json, validators/interface_compat.mjs; protocol frozen 2026-11-14T21:46:46.176Z; scored once on holdout-A | held |
| A candidate that helps but harms something else is rejected, and its result kept | accuracy 0.5 → 0.6, but Share of safe changes blocked: candidate 50.0%, incumbent 0.0%; allowed margin 5.0%. | held |
| A revision is never scored on cases its lineage has already seen results for | first attempt on holdout-A; revision on holdout-B; the first set is recorded as development data for this lineage | held |
| The revised candidate is compared with the incumbent and the fixed original baseline | accuracy 0.4875 → 1 (difference 0.5125, 95% interval 0.4 to 0.625, n=80); baseline 0.4875 | held |
| Acceptance creates a release manifest but does not make it the default | r2: execution v2, coordination v1, evolution v1; rollback target r1; active release still r1 | held |
| The qualified release is monitored in a bounded canary on fresh cases | accuracy_drop_vs_approval=0 (limit 0.05); escaped_defect_rate_increase=0 (limit 0.02); canary_missions_with_acceptance_failures=— (limit 0) | held |
| A healthy canary is retained and applies to future work only | active release is now r2; r1 is retired and remains the rollback target | held |
| The evaluation ledger is complete and intact | 17 ledger entries, hash chain intact; protected store matches its sealed digest | held |

Files in this folder: `1-naive-rejected.receipt.json`, `1-naive-rejected.receipt.md`, `2-revised-accepted.receipt.json`, `2-revised-accepted.receipt.md`, `release-manifests.json`, `release-manifests.md`, `ledger.json`, `canary.json`, `observations.json`.

Reproduce with `npm run demo:c`. Run time 949 ms.
