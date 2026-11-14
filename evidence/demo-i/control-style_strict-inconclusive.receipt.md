# Improvement receipt rcpt_0mwgqnxpa136531bbf3

> DETERMINISTIC FIXTURE EVALUATION — executable checks on synthetic cases; no model was run

**Decision: INCONCLUSIVE** — No demonstrated improvement: the 95% interval of the difference in accuracy (0 to 0) includes zero.

Decided by release-gate at 2026-11-14T18:28:10.462Z. Level: execution. Experiment: `exp_0mwgqnxg00z9b2d3bd0`.

## Problem and supporting observations

Review failures recorded under r1: style_nit (0 verified, 30 unverified reports).

Verified failure observations cited: 30 (for example `obs_0mwgqnxca0335077f89`, `obs_0mwgqnxcb04c783ea93`, `obs_0mwgqnxcb05ac96a2e7`).

## Hypothesis

If change review also runs style_strict, verified failures of style_nit will be blocked without blocking safe changes.

Expected benefit: Fewer approved breaking changes of these classes.

Possible regressions stated in advance:
- Safe changes could be blocked
- Each review runs one more step

## Parent version and exact change

Parent: execution v1 (`bfbd9eb006fa426e`). Candidate: `b3c8236f0b256736`.

Adds the style_strict check to the change-review skill.

| File | Before | After |
|---|---|---|
| execution.json | 623fb23304c6 | f7fc5926d65b |
| validators/style_strict.mjs | new | 73b02bdbef5b |

## Evaluation

- Protocol: promotion-policy@1/execution, frozen at 2026-11-14T18:28:10.128Z, before the candidate was submitted
- Policy hash: `a79f643c873bbd0d`
- Workload: review:holdout-A; snapshot:b445c17644dffbcb65d506d32e8f7f315c06e3c623c461b8ef50b7769d978eac
- Held-out set: holdout-A
- Executor: validator-executor (deterministic; rerun; 1 pass)

### Attempts

| # | Kind | Cases | Note |
|---|---|---|---|
| 1 | development | 40 | development check by the candidate author |
| 2 | holdout | 80 | one evaluation on holdout-A |

Resource use: 281 experiment units, 284 ms, 0 model calls, cost not measured.

## Outcome differences and uncertainty

| Metric | Candidate | Incumbent | Baseline | Difference vs incumbent | 95% interval | n |
|---|---|---|---|---|---|---|
| accuracy (higher is better) | 0.5 | 0.5 | 0.5 | 0 | 0 to 0 | 80 |
| harm_per_review (lower is better) | 2.5 | 2.5 | 2.5 | 0 | 0 to 0 | 80 |
| escaped_defect_rate (lower is better) | 0.8 | 0.8 | 0.8 | 0 | — | 80 |
| false_alarm_rate (lower is better) | 0 | 0 | 0 | 0 | — | 80 |
| steps_per_review (lower is better) | 3 | 2 | 2 | 1 | 1 to 1 | 80 |
| wall_ms_per_review (lower is better) | 0.145 | 0.102 | 0.148 | 0.043 | — | 80 |

Method for the primary metric: paired bootstrap over the same 80 cases (20000 resamples, seeded); sign test: 0 better, 0 worse, 80 same, p=1.

## Gates

| Gate | Kind | Verdict | Meaning |
|---|---|---|---|
| Rules and records are intact | HARD_GATE | PASSED | The protected rules, held-out cases and records are byte-identical to the sealed state, before and after the evaluation. |
| No forbidden capabilities | HARD_GATE | PASSED | The candidate code uses no file, process, network or dynamic-code capability. |
| Held-out cases are unseen by this lineage | HARD_GATE | PASSED | Scored on holdout-A, which this candidate lineage has not been scored on before. |
| Required verification steps are performed | HARD_GATE | PASSED | Every step that may not be omitted fired on its probe case. |
| Enough scored cases | HARD_GATE | PASSED | 80 cases scored; at least 40 are required. |
| No more defects escape | HARD_GATE | PASSED | Share of breaking changes approved: candidate 80.0%, incumbent 80.0%. |
| Safe changes are not blocked | HARD_GATE | PASSED | Share of safe changes blocked: candidate 0.0%, incumbent 0.0%; allowed margin 5.0%. |
| No cumulative regression against the original baseline | HARD_GATE | PASSED | Accuracy: candidate 50.0%, original baseline 50.0%. |
| Cost stays within bound | HARD_GATE | PASSED | Steps per review: candidate 3, incumbent 2; at most 5× is allowed. |
| Review accuracy | WEIGHTED | FAILED | Accuracy changed by 0 (95% interval 0 to 0). |
| Severity-weighted harm | WEIGHTED | FAILED | Harm per review changed by 0. |
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

No release was created. The candidate and this result are kept.

Receipt hash: `d1b4299a50c1f9164d10cd00a81a3a124a02ac331e06f9a4de939c3683dd252f`
