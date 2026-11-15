# Improvement receipt rcpt_0mwgyaepd1ce0b7c203

> DETERMINISTIC FIXTURE EVALUATION — executable checks on synthetic cases; no model was run

**Decision: ACCEPT** — Accepted: accuracy improved by 0.1125 against the incumbent (95% interval 0.05 to 0.1875) with every hard gate passed.

Decided by release-gate at 2026-11-14T22:01:36.241Z. Level: execution. Experiment: `exp_0mwgyaef118468ee182`.

## Problem and supporting observations

Review failures recorded under r1: field_removed (4 verified, 0 unverified reports); field_renamed (3 verified, 0 unverified reports).

Verified failure observations cited: 7 (for example `obs_0mwgyadz4zq090e2ed1`, `obs_0mwgyadz4zre4057ef9`, `obs_0mwgyadz4zt737ebf3b`).

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

- Protocol: promotion-policy@1/execution, frozen at 2026-11-14T22:01:35.869Z, before the candidate was submitted
- Policy hash: `a79f643c873bbd0d`
- Workload: review:holdout-B; snapshot:c796e6d9885c1c55e9fa0d306dc8b88a3a77e397ced64757e31d86d65642c5ce
- Held-out set: holdout-B
- Executor: validator-executor (deterministic; rerun; 1 pass)

### Attempts

| # | Kind | Cases | Note |
|---|---|---|---|
| 1 | development | 40 | development check by the candidate author |
| 2 | holdout | 80 | one evaluation on holdout-B |

Resource use: 281 experiment units, 319 ms, 0 model calls, cost not measured.

## Outcome differences and uncertainty

| Metric | Candidate | Incumbent | Baseline | Difference vs incumbent | 95% interval | n |
|---|---|---|---|---|---|---|
| accuracy (higher is better) | 0.6 | 0.4875 | 0.4875 | 0.1125 | 0.05 to 0.1875 | 80 |
| harm_per_review (lower is better) | 1.8375 | 2.4 | 2.4 | -0.5625 | -0.9375 to -0.25 | 80 |
| escaped_defect_rate (lower is better) | 0.7442 | 0.9535 | 0.9535 | -0.2093 | — | 80 |
| false_alarm_rate (lower is better) | 0 | 0 | 0 | 0 | — | 80 |
| steps_per_review (lower is better) | 3 | 2 | 2 | 1 | 1 to 1 | 80 |
| wall_ms_per_review (lower is better) | 0.131 | 0.14 | 0.152 | -0.009 | — | 80 |

Method for the primary metric: paired bootstrap over the same 80 cases (20000 resamples, seeded); sign test: 9 better, 0 worse, 71 same, p=0.00391.

## Gates

| Gate | Kind | Verdict | Meaning |
|---|---|---|---|
| Rules and records are intact | HARD_GATE | PASSED | The protected rules, held-out cases and records are byte-identical to the sealed state, before and after the evaluation. |
| No forbidden capabilities | HARD_GATE | PASSED | The candidate code uses no file, process, network or dynamic-code capability. |
| Held-out cases are unseen by this lineage | HARD_GATE | PASSED | Scored on holdout-B, which this candidate lineage has not been scored on before. |
| Required verification steps are performed | HARD_GATE | PASSED | Every step that may not be omitted fired on its probe case. |
| Enough scored cases | HARD_GATE | PASSED | 80 cases scored; at least 40 are required. |
| No more defects escape | HARD_GATE | PASSED | Share of breaking changes approved: candidate 74.4%, incumbent 95.3%. |
| Safe changes are not blocked | HARD_GATE | PASSED | Share of safe changes blocked: candidate 0.0%, incumbent 0.0%; allowed margin 5.0%. |
| No cumulative regression against the original baseline | HARD_GATE | PASSED | Accuracy: candidate 60.0%, original baseline 48.8%. |
| Cost stays within bound | HARD_GATE | PASSED | Steps per review: candidate 3, incumbent 2; at most 5× is allowed. |
| Review accuracy | WEIGHTED | PASSED | Accuracy changed by 0.1125 (95% interval 0.05 to 0.1875). |
| Severity-weighted harm | WEIGHTED | PASSED | Harm per review changed by -0.5625. |
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
| execution | v2 | `4721f415018b69f7` |
| coordination | v1 | `a2731e7d2ba012c8` |
| evolution | v1 | `d81a4b43a3303a68` |

Policy hash `a79f643c873bbd0d`; evaluation snapshot `c796e6d9885c1c55`; receipt rcpt_0mwgyaepd1ce0b7c203; manifest hash `93bb424f8f54eb4b`.

Rollback target: r1.

Receipt hash: `5193c7854775cc38806ac710d6113688bbd771293999049882d35c79c7ec10a1`
