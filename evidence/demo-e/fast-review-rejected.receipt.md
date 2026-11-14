# Improvement receipt rcpt_0mwgxrrdya8e4087d3f

> DETERMINISTIC FIXTURE EVALUATION — executable checks on synthetic cases; no model was run

**Decision: REJECT** — Rejected: required verification steps are performed; no more defects escape; no cumulative regression against the original baseline failed. The candidate omits a step that may not be omitted: tests_present. A probe case with a known answer was not caught.

Decided by release-gate at 2026-11-14T21:47:06.214Z. Level: execution. Experiment: `exp_0mwgxrr5ua48528a55c`.

## Problem and supporting observations

Change review takes two steps per change; most changes are approved anyway.

Verified failure observations cited: 0.

## Hypothesis

Dropping the test-presence step halves review cost without changing outcomes that matter.

Expected benefit: Review cost per change falls by half.

Possible regressions stated in advance:
- Changes without tests would no longer be blocked

## Parent version and exact change

Parent: execution v1 (`bfbd9eb006fa426e`). Candidate: `ad307fc1e0c2ada6`.

Removes the tests_present step from the procedure and its validator from the skill.

| File | Before | After |
|---|---|---|
| execution.json | 623fb23304c6 | 1dd6f7e791bb |
| validators/tests_present.mjs (removed) | d16a0f076aa2 | removed |

## Evaluation

- Protocol: promotion-policy@1/execution, frozen at 2026-11-14T21:47:05.922Z, before the candidate was submitted
- Policy hash: `a79f643c873bbd0d`
- Workload: review:holdout-A; snapshot:785515e9f99f0f1a3144692f8af057a82509cde041285f47e044821a13517a8c
- Held-out set: holdout-A
- Executor: validator-executor (deterministic; rerun; 1 pass)

### Attempts

| # | Kind | Cases | Note |
|---|---|---|---|
| 1 | development | 40 | development check by the candidate author |
| 2 | holdout | 80 | one evaluation on holdout-A |

Resource use: 281 experiment units, 251 ms, 0 model calls, cost not measured.

## Outcome differences and uncertainty

| Metric | Candidate | Incumbent | Baseline | Difference vs incumbent | 95% interval | n |
|---|---|---|---|---|---|---|
| accuracy (higher is better) | 0.375 | 0.5 | 0.5 | -0.125 | -0.2 to -0.0625 | 80 |
| harm_per_review (lower is better) | 2.75 | 2.5 | 2.5 | 0.25 | 0.125 to 0.4 | 80 |
| escaped_defect_rate (lower is better) | 1 | 0.8 | 0.8 | 0.2 | — | 80 |
| false_alarm_rate (lower is better) | 0 | 0 | 0 | 0 | — | 80 |
| steps_per_review (lower is better) | 1 | 2 | 2 | -1 | -1 to -1 | 80 |
| wall_ms_per_review (lower is better) | 0.087 | 0.104 | 0.108 | -0.017 | — | 80 |

Method for the primary metric: paired bootstrap over the same 80 cases (20000 resamples, seeded); sign test: 0 better, 10 worse, 70 same, p=0.00195.

## Gates

| Gate | Kind | Verdict | Meaning |
|---|---|---|---|
| Rules and records are intact | HARD_GATE | PASSED | The protected rules, held-out cases and records are byte-identical to the sealed state, before and after the evaluation. |
| No forbidden capabilities | HARD_GATE | PASSED | The candidate code uses no file, process, network or dynamic-code capability. |
| Held-out cases are unseen by this lineage | HARD_GATE | PASSED | Scored on holdout-A, which this candidate lineage has not been scored on before. |
| Required verification steps are performed | HARD_GATE | FAILED | The candidate omits a step that may not be omitted: tests_present. A probe case with a known answer was not caught. |
| Enough scored cases | HARD_GATE | PASSED | 80 cases scored; at least 40 are required. |
| No more defects escape | HARD_GATE | FAILED | Share of breaking changes approved: candidate 100.0%, incumbent 80.0%. |
| Safe changes are not blocked | HARD_GATE | PASSED | Share of safe changes blocked: candidate 0.0%, incumbent 0.0%; allowed margin 5.0%. |
| No cumulative regression against the original baseline | HARD_GATE | FAILED | Accuracy: candidate 37.5%, original baseline 50.0%. |
| Cost stays within bound | HARD_GATE | PASSED | Steps per review: candidate 1, incumbent 2; at most 5× is allowed. |
| Review accuracy | WEIGHTED | FAILED | Accuracy changed by -0.125 (95% interval -0.2 to -0.0625). |
| Severity-weighted harm | WEIGHTED | FAILED | Harm per review changed by 0.25. |
| Cost per review | WEIGHTED | PASSED | Steps per review changed by -1. |

## Known regressions

- missing_tests: 0/10 correct, down from 10/10 under the incumbent

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

Receipt hash: `b52d4e7644c9f2f6a90033b923511755647748a1ec5ae6c66e5bfbcc210c549b`
