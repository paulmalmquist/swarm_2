# Improvement receipt rcpt_0mwgq49g4ayb7f1fef0

> DETERMINISTIC FIXTURE EVALUATION — executable checks on synthetic cases; no model was run

**Decision: ACCEPT** — Accepted: accuracy improved by 0.1625 against the incumbent (95% interval 0.0875 to 0.25) with every hard gate passed.

Decided by release-gate at 2026-11-14T18:12:52.565Z. Level: execution. Experiment: `exp_0mwgq4956auf2ef8cc1`.

## Problem and supporting observations

Review failures recorded under r1: field_removed (4 verified, 0 unverified reports); field_renamed (3 verified, 0 unverified reports).

Verified failure observations cited: 7 (for example `obs_0mwgq48wb9k3cc3680f`, `obs_0mwgq48wb9l18b43b3d`, `obs_0mwgq48wc9n2899562c`).

## Hypothesis

If change review also runs guard_removed_toplevel, verified failures of field_removed, field_renamed will be blocked without blocking safe changes.

Expected benefit: Fewer approved breaking changes of these classes.

Possible regressions stated in advance:
- Safe changes could be blocked
- Each review runs one more step

## Parent version and exact change

Parent: execution v1 (`bfbd9eb006fa426e`). Candidate: `4721f415018b69f7`.

Adds the guard_removed_toplevel check to the change-review skill.

| File | Before | After |
|---|---|---|
| execution.json | 623fb23304c6 | b3d8be7800c2 |
| validators/guard_removed_toplevel.mjs | new | 0f3e2bc4ff5c |

## Evaluation

- Protocol: promotion-policy@1/execution, frozen at 2026-11-14T18:12:52.170Z, before the candidate was submitted
- Policy hash: `19b51d6fce298df7`
- Workload: review:holdout-A; snapshot:8af9cae906fff0d3f34d985d0c49f53c762b10e40873a6fd0331abc54fedfbf0
- Held-out set: holdout-A
- Executor: validator-executor (deterministic; rerun; 1 pass)

### Attempts

| # | Kind | Cases | Note |
|---|---|---|---|
| 1 | development | 40 | development check by the candidate author |
| 2 | holdout | 80 | one evaluation on holdout-A |

Resource use: 281 experiment units, 339 ms, 0 model calls, cost not measured.

## Outcome differences and uncertainty

| Metric | Candidate | Incumbent | Baseline | Difference vs incumbent | 95% interval | n |
|---|---|---|---|---|---|---|
| accuracy (higher is better) | 0.6625 | 0.5 | 0.5 | 0.1625 | 0.0875 to 0.25 | 80 |
| harm_per_review (lower is better) | 1.6875 | 2.5 | 2.5 | -0.8125 | -1.25 to -0.4375 | 80 |
| escaped_defect_rate (lower is better) | 0.54 | 0.8 | 0.8 | -0.26 | — | 80 |
| false_alarm_rate (lower is better) | 0 | 0 | 0 | 0 | — | 80 |
| steps_per_review (lower is better) | 3 | 2 | 2 | 1 | 1 to 1 | 80 |
| wall_ms_per_review (lower is better) | 0.174 | 0.106 | 0.12 | 0.067 | — | 80 |

Method for the primary metric: paired bootstrap over the same 80 cases (20000 resamples, seeded); sign test: 13 better, 0 worse, 67 same, p=0.00024.

## Gates

| Gate | Kind | Verdict | Meaning |
|---|---|---|---|
| Rules and records are intact | HARD_GATE | PASSED | The protected rules, held-out cases and records are byte-identical to the sealed state, before and after the evaluation. |
| No forbidden capabilities | HARD_GATE | PASSED | The candidate code uses no file, process, network or dynamic-code capability. |
| Held-out cases are unseen by this lineage | HARD_GATE | PASSED | Scored on holdout-A, which this candidate lineage has not been scored on before. |
| Required verification steps are performed | HARD_GATE | PASSED | Every step that may not be omitted fired on its probe case. |
| Enough scored cases | HARD_GATE | PASSED | 80 cases scored; at least 40 are required. |
| No more defects escape | HARD_GATE | PASSED | Share of breaking changes approved: candidate 54.0%, incumbent 80.0%. |
| Safe changes are not blocked | HARD_GATE | PASSED | Share of safe changes blocked: candidate 0.0%, incumbent 0.0%; allowed margin 5.0%. |
| No cumulative regression against the original baseline | HARD_GATE | PASSED | Accuracy: candidate 66.3%, original baseline 50.0%. |
| Cost stays within bound | HARD_GATE | PASSED | Steps per review: candidate 3, incumbent 2; at most 5× is allowed. |
| Review accuracy | WEIGHTED | PASSED | Accuracy changed by 0.1625 (95% interval 0.0875 to 0.25). |
| Severity-weighted harm | WEIGHTED | PASSED | Harm per review changed by -0.8125. |
| Cost per review | WEIGHTED | FAILED | Steps per review changed by 1. |

## Known regressions

- Each review runs 1 more step(s)

## Limitations

- Evaluated by executing the skill's validators on synthetic change-review cases. No model was run, so this says nothing about how a model worker would use the procedure text.
- One deterministic pass over 80 cases: the interval reflects which cases were drawn, not run-to-run variation.
- Fixture evidence does not certify live use.

## Isolation

- Mode: **enforced** (operating-system user separation: yes, uid 65534; Node permission model: yes)
- Protected store intact before and after: yes
- candidate code runs as uid 65534; the protected store is owned by uid 0 with mode 0700

## Release

Release **r3** (canary; evidence basis: fixture; parent r1)

| Level | Version | Content hash |
|---|---|---|
| execution | v2 | `4721f415018b69f7` |
| coordination | v1 | `a2731e7d2ba012c8` |
| evolution | v1 | `d81a4b43a3303a68` |

Policy hash `19b51d6fce298df7`; evaluation snapshot `8af9cae906fff0d3`; receipt rcpt_0mwgq49g4ayb7f1fef0; manifest hash `f631913347731b55`.

Rollback target: r1.

Receipt hash: `98903ed1da800e47be4a99d975e03fa145823b6f6648c3067dda77a9605eea30`
