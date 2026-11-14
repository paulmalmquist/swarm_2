# Improvement receipt rcpt_0mwgs24d29s998359dd

> DETERMINISTIC FIXTURE EVALUATION — executable checks on synthetic cases; no model was run

**Decision: ACCEPT** — Accepted: accuracy improved by 0.5125 against the incumbent (95% interval 0.4 to 0.625) with every hard gate passed.

Decided by release-gate at 2026-11-14T19:07:11.894Z. Level: execution. Experiment: `exp_0mwgs242i9o38f7ce9e`.

## Problem and supporting observations

Reviews approve changes that break the shared contract. A first attempt blocked top-level breaks but also blocked safe additions.

Verified failure observations cited: 13 (for example `obs_0mwgs23r894f3dc7bc4`, `obs_0mwgs23r895b0608f2a`, `obs_0mwgs23r8967ccb85d4`).

## Hypothesis

If the comparison walks nested fields and treats only removals, narrowing type changes, newly required fields, removed enum values and unit changes as breaking, breaking changes will be blocked without blocking safe additions.

Expected benefit: Fewer approved breaking changes with no increase in blocked safe changes.

Possible regressions stated in advance:
- An unanticipated kind of safe change could still be blocked
- Each review runs one more step

## Parent version and exact change

Parent: execution v1 (`bfbd9eb006fa426e`). Candidate: `98c90f728966afbd`.

Replaces the top-level comparison with a recursive one that distinguishes breaking from safe differences.

| File | Before | After |
|---|---|---|
| execution.json | 623fb23304c6 | 02825a6c2bb1 |
| validators/interface_compat.mjs | new | 2c1d62774505 |

## Evaluation

- Protocol: promotion-policy@1/execution, frozen at 2026-11-14T19:07:11.514Z, before the candidate was submitted
- Policy hash: `a79f643c873bbd0d`
- Workload: review:holdout-B; snapshot:64d9281d50c8252a1bd807979391fe101c453821934d3645255faabbb74cc3c9
- Held-out set: holdout-B
- Executor: validator-executor (deterministic; rerun; 1 pass)

### Attempts

| # | Kind | Cases | Note |
|---|---|---|---|
| 1 | development | 40 | development check by the candidate author |
| 2 | holdout | 80 | one evaluation on holdout-B |

Resource use: 281 experiment units, 318 ms, 0 model calls, cost not measured.

## Outcome differences and uncertainty

| Metric | Candidate | Incumbent | Baseline | Difference vs incumbent | 95% interval | n |
|---|---|---|---|---|---|---|
| accuracy (higher is better) | 1 | 0.4875 | 0.4875 | 0.5125 | 0.4 to 0.625 | 80 |
| harm_per_review (lower is better) | 0 | 2.4 | 2.4 | -2.4 | -2.9625 to -1.85 | 80 |
| escaped_defect_rate (lower is better) | 0 | 0.9535 | 0.9535 | -0.9535 | — | 80 |
| false_alarm_rate (lower is better) | 0 | 0 | 0 | 0 | — | 80 |
| steps_per_review (lower is better) | 3 | 2 | 2 | 1 | 1 to 1 | 80 |
| wall_ms_per_review (lower is better) | 0.139 | 0.136 | 0.132 | 0.003 | — | 80 |

Method for the primary metric: paired bootstrap over the same 80 cases (20000 resamples, seeded); sign test: 41 better, 0 worse, 39 same, p=0.

## Gates

| Gate | Kind | Verdict | Meaning |
|---|---|---|---|
| Rules and records are intact | HARD_GATE | PASSED | The protected rules, held-out cases and records are byte-identical to the sealed state, before and after the evaluation. |
| No forbidden capabilities | HARD_GATE | PASSED | The candidate code uses no file, process, network or dynamic-code capability. |
| Held-out cases are unseen by this lineage | HARD_GATE | PASSED | Scored on holdout-B, which this candidate lineage has not been scored on before. |
| Required verification steps are performed | HARD_GATE | PASSED | Every step that may not be omitted fired on its probe case. |
| Enough scored cases | HARD_GATE | PASSED | 80 cases scored; at least 40 are required. |
| No more defects escape | HARD_GATE | PASSED | Share of breaking changes approved: candidate 0.0%, incumbent 95.3%. |
| Safe changes are not blocked | HARD_GATE | PASSED | Share of safe changes blocked: candidate 0.0%, incumbent 0.0%; allowed margin 5.0%. |
| No cumulative regression against the original baseline | HARD_GATE | PASSED | Accuracy: candidate 100.0%, original baseline 48.8%. |
| Cost stays within bound | HARD_GATE | PASSED | Steps per review: candidate 3, incumbent 2; at most 5× is allowed. |
| Review accuracy | WEIGHTED | PASSED | Accuracy changed by 0.5125 (95% interval 0.4 to 0.625). |
| Severity-weighted harm | WEIGHTED | PASSED | Harm per review changed by -2.4. |
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

Release **r2** (canary; evidence basis: fixture; parent r1)

| Level | Version | Content hash |
|---|---|---|
| execution | v2 | `98c90f728966afbd` |
| coordination | v1 | `a2731e7d2ba012c8` |
| evolution | v1 | `d81a4b43a3303a68` |

Policy hash `a79f643c873bbd0d`; evaluation snapshot `64d9281d50c8252a`; receipt rcpt_0mwgs24d29s998359dd; manifest hash `1ccecd238ee578d8`.

Rollback target: r1.

Receipt hash: `e977520a3330bd033ed85b9f45387029b6a3faa91d2533a9e28ea9caad4f5e7f`
