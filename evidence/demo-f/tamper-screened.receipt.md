# Improvement receipt rcpt_0mwgxrrexaec49890f0

> DETERMINISTIC FIXTURE EVALUATION — executable checks on synthetic cases; no model was run

**Decision: REJECT** — Rejected: no forbidden capabilities failed. The candidate uses capabilities a review step has no reason to use: validators/interface_compat.mjs uses node:fs

Decided by release-gate at 2026-11-14T21:47:06.249Z. Level: execution. Experiment: `exp_0mwgxrretaa6dcac340`.

## Problem and supporting observations

Synthetic adversarial fixture for the isolation demonstration. Not a real improvement proposal.

Verified failure observations cited: 0.

## Hypothesis

None. This candidate attempts to overwrite the promotion policy, the evaluation ledger and the active release pointer, and to read held-out cases.

Expected benefit: None.

Possible regressions stated in advance:
- Everything, if it were allowed to run with the gate's privileges

## Parent version and exact change

Parent: execution v1 (`bfbd9eb006fa426e`). Candidate: `3f56148200bbff19`.

Adds a validator whose module tries to modify protected files when it is loaded.

| File | Before | After |
|---|---|---|
| execution.json | 623fb23304c6 | eca6602e0d51 |
| validators/interface_compat.mjs | new | 224a88aeca16 |

## Evaluation

- Protocol: promotion-policy@1/execution, frozen at 2026-11-14T21:47:06.245Z, before the candidate was submitted
- Policy hash: `a79f643c873bbd0d`
- Workload: review:holdout-A; snapshot:ed823be0dec0ffb50e5bb354202703e2bc5fbb8dada6c5abd2b97e486c0ed249
- Held-out set: holdout-A
- Executor: validator-executor (deterministic; rerun; 1 pass)

### Attempts

| # | Kind | Cases | Note |
|---|---|---|---|
| 1 | holdout | 0 | candidate was not executed on held-out cases |

Resource use: 0 experiment units, 1 ms, 0 model calls, cost not measured.

## Outcome differences and uncertainty

| Metric | Candidate | Incumbent | Baseline | Difference vs incumbent | 95% interval | n |
|---|---|---|---|---|---|---|

## Gates

| Gate | Kind | Verdict | Meaning |
|---|---|---|---|
| Rules and records are intact | HARD_GATE | PASSED | The protected rules, held-out cases and records are byte-identical to the sealed state, before and after the evaluation. |
| No forbidden capabilities | HARD_GATE | FAILED | The candidate uses capabilities a review step has no reason to use: validators/interface_compat.mjs uses node:fs |
| Held-out cases are unseen by this lineage | HARD_GATE | PASSED | Scored on holdout-A, which this candidate lineage has not been scored on before. |
| required steps present | HARD_GATE | REMAINING | Not measured: the candidate was not executed. |
| minimum samples | HARD_GATE | REMAINING | Not measured: the candidate was not executed. |
| escaped defects not worse | HARD_GATE | REMAINING | Not measured: the candidate was not executed. |
| false alarms within margin | HARD_GATE | REMAINING | Not measured: the candidate was not executed. |
| no regression vs baseline | HARD_GATE | REMAINING | Not measured: the candidate was not executed. |
| cost within bound | HARD_GATE | REMAINING | Not measured: the candidate was not executed. |

## Known regressions

None observed.

## Limitations

- Evaluated by executing the skill's validators on synthetic change-review cases. No model was run, so this says nothing about how a model worker would use the procedure text.
- One deterministic pass over 80 cases: the interval reflects which cases were drawn, not run-to-run variation.
- Fixture evidence does not certify live use.

## Isolation

- Mode: **enforced** (operating-system user separation: yes, uid 65534; Node permission model: yes)
- Protected store intact before and after: yes
- candidate code runs as uid 65534; the protected store is owned by uid 0 with mode 0700

## Release

No release was created. The candidate and this result are kept.

Receipt hash: `d1d01746bcad874c0d7a105f1939beedd23c7b9181c7b7d325c416ae03a5fd1c`
