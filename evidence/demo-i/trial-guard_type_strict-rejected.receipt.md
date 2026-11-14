# Improvement receipt rcpt_0mwgs5yds3f58b2e1cd

> DETERMINISTIC FIXTURE EVALUATION — executable checks on synthetic cases; no model was run

**Decision: REJECT** — Rejected: safe changes are not blocked failed. Share of safe changes blocked: candidate 13.5%, incumbent 0.0%; allowed margin 5.0%.

Decided by release-gate at 2026-11-14T19:10:10.768Z. Level: execution. Experiment: `exp_0mwgs5y3k3b9df4615c`.

## Problem and supporting observations

Review failures recorded under r1: type_changed (3 verified, 0 unverified reports).

Verified failure observations cited: 3 (for example `obs_0mwgs5xbc1r48f7f41c`, `obs_0mwgs5xbd1wef393720`, `obs_0mwgs5xbd208dc35f23`).

## Hypothesis

If change review also runs guard_type_strict, verified failures of type_changed, nullability_removed will be blocked without blocking safe changes.

Expected benefit: Fewer approved breaking changes of these classes.

Possible regressions stated in advance:
- Safe changes could be blocked
- Each review runs one more step

## Parent version and exact change

Parent: execution v1 (`bfbd9eb006fa426e`). Candidate: `f1ecac070a2575a1`.

Adds the guard_type_strict check to the change-review skill.

| File | Before | After |
|---|---|---|
| execution.json | 623fb23304c6 | 756a52b3ba98 |
| validators/guard_type_strict.mjs | new | a8f2f45516c0 |

## Evaluation

- Protocol: promotion-policy@1/execution, frozen at 2026-11-14T19:10:10.400Z, before the candidate was submitted
- Policy hash: `a79f643c873bbd0d`
- Workload: review:holdout-B; snapshot:0b7c3786d8caf5908e83e2c2313f0b8d0dd1c3b6371539bd392f3eaade51abcf
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
| accuracy (higher is better) | 0.55 | 0.4875 | 0.4875 | 0.0625 | -0.025 to 0.1625 | 80 |
| harm_per_review (lower is better) | 1.9875 | 2.4 | 2.4 | -0.4125 | -0.725 to -0.1375 | 80 |
| escaped_defect_rate (lower is better) | 0.7209 | 0.9535 | 0.9535 | -0.2326 | — | 80 |
| false_alarm_rate (lower is better) | 0.1351 | 0 | 0 | 0.1351 | — | 80 |
| steps_per_review (lower is better) | 3 | 2 | 2 | 1 | 1 to 1 | 80 |
| wall_ms_per_review (lower is better) | 0.172 | 0.12 | 0.144 | 0.052 | — | 80 |

Method for the primary metric: paired bootstrap over the same 80 cases (20000 resamples, seeded); sign test: 10 better, 5 worse, 65 same, p=0.30176.

## Gates

| Gate | Kind | Verdict | Meaning |
|---|---|---|---|
| Rules and records are intact | HARD_GATE | PASSED | The protected rules, held-out cases and records are byte-identical to the sealed state, before and after the evaluation. |
| No forbidden capabilities | HARD_GATE | PASSED | The candidate code uses no file, process, network or dynamic-code capability. |
| Held-out cases are unseen by this lineage | HARD_GATE | PASSED | Scored on holdout-B, which this candidate lineage has not been scored on before. |
| Required verification steps are performed | HARD_GATE | PASSED | Every step that may not be omitted fired on its probe case. |
| Enough scored cases | HARD_GATE | PASSED | 80 cases scored; at least 40 are required. |
| No more defects escape | HARD_GATE | PASSED | Share of breaking changes approved: candidate 72.1%, incumbent 95.3%. |
| Safe changes are not blocked | HARD_GATE | FAILED | Share of safe changes blocked: candidate 13.5%, incumbent 0.0%; allowed margin 5.0%. |
| No cumulative regression against the original baseline | HARD_GATE | PASSED | Accuracy: candidate 55.0%, original baseline 48.8%. |
| Cost stays within bound | HARD_GATE | PASSED | Steps per review: candidate 3, incumbent 2; at most 5× is allowed. |
| Review accuracy | WEIGHTED | PASSED | Accuracy changed by 0.0625 (95% interval -0.025 to 0.1625). |
| Severity-weighted harm | WEIGHTED | PASSED | Harm per review changed by -0.4125. |
| Cost per review | WEIGHTED | FAILED | Steps per review changed by 1. |

## Known regressions

- nullability_added: 2/7 correct, down from 7/7 under the incumbent
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

No release was created. The candidate and this result are kept.

Receipt hash: `a24068e813b603c8279b35c574be587934cc7b3d6251cbeeaaa9c28a1f1eb055`
