# Improvement receipt rcpt_0mwgq1tkh9m95aba3ac

> DETERMINISTIC FIXTURE EVALUATION — executable checks on synthetic cases; no model was run

**Decision: REJECT** — Rejected: safe changes are not blocked failed. Share of safe changes blocked: candidate 50.0%, incumbent 0.0%; allowed margin 5.0%.

Decided by release-gate at 2026-11-14T18:10:58.673Z. Level: execution. Experiment: `exp_0mwgq1t8s9i5ad4fcbb`.

## Problem and supporting observations

Reviews approve changes that break the shared contract: removed, renamed and retyped fields pass because the procedure never compares the contract before and after.

Verified failure observations cited: 12 (for example `obs_0mwgq1t8p948e19da4f`, `obs_0mwgq1t8p9598591376`, `obs_0mwgq1t8p96bc05d697`).

## Hypothesis

If the review procedure compares the contract before and after the change, breaking interface changes will be blocked and review accuracy on fresh changes will rise.

Expected benefit: Fewer approved breaking changes; higher review accuracy.

Possible regressions stated in advance:
- Safe changes could be blocked if the comparison is too eager
- Each review runs one more step

## Parent version and exact change

Parent: execution v1 (`bfbd9eb006fa426e`). Candidate: `f0309264a641e273`.

Adds validator interface_compat (top-level comparison of fields and types) and a procedure step that runs it.

| File | Before | After |
|---|---|---|
| execution.json | 623fb23304c6 | d5a3c521fbae |
| validators/interface_compat.mjs | new | b16000cb240b |

## Evaluation

- Protocol: promotion-policy@1/execution, frozen at 2026-11-14T18:10:58.252Z, before the candidate was submitted
- Policy hash: `19b51d6fce298df7`
- Workload: review:holdout-A; snapshot:1df59ee19ef488368da8cda4db29cf7143623fa8ef13c1669b44e4b7e60170ce
- Held-out set: holdout-A
- Executor: validator-executor (deterministic; rerun; 1 pass)

### Attempts

| # | Kind | Cases | Note |
|---|---|---|---|
| 1 | development | 40 | development check by the candidate author |
| 2 | holdout | 80 | one evaluation on holdout-A |

Resource use: 281 experiment units, 353 ms, 0 model calls, cost not measured.

## Outcome differences and uncertainty

| Metric | Candidate | Incumbent | Baseline | Difference vs incumbent | 95% interval | n |
|---|---|---|---|---|---|---|
| accuracy (higher is better) | 0.6 | 0.5 | 0.5 | 0.1 | -0.05 to 0.25 | 80 |
| harm_per_review (lower is better) | 1.4 | 2.5 | 2.5 | -1.1 | -1.6125 to -0.625 | 80 |
| escaped_defect_rate (lower is better) | 0.34 | 0.8 | 0.8 | -0.46 | — | 80 |
| false_alarm_rate (lower is better) | 0.5 | 0 | 0 | 0.5 | — | 80 |
| steps_per_review (lower is better) | 3 | 2 | 2 | 1 | 1 to 1 | 80 |
| wall_ms_per_review (lower is better) | 0.195 | 0.154 | 0.139 | 0.041 | — | 80 |

Method for the primary metric: paired bootstrap over the same 80 cases (20000 resamples, seeded); sign test: 23 better, 15 worse, 42 same, p=0.25588.

## Gates

| Gate | Kind | Verdict | Meaning |
|---|---|---|---|
| Rules and records are intact | HARD_GATE | PASSED | The protected rules, held-out cases and records are byte-identical to the sealed state, before and after the evaluation. |
| No forbidden capabilities | HARD_GATE | PASSED | The candidate code uses no file, process, network or dynamic-code capability. |
| Held-out cases are unseen by this lineage | HARD_GATE | PASSED | Scored on holdout-A, which this candidate lineage has not been scored on before. |
| Required verification steps are performed | HARD_GATE | PASSED | Every step that may not be omitted fired on its probe case. |
| Enough scored cases | HARD_GATE | PASSED | 80 cases scored; at least 40 are required. |
| No more defects escape | HARD_GATE | PASSED | Share of breaking changes approved: candidate 34.0%, incumbent 80.0%. |
| Safe changes are not blocked | HARD_GATE | FAILED | Share of safe changes blocked: candidate 50.0%, incumbent 0.0%; allowed margin 5.0%. |
| No cumulative regression against the original baseline | HARD_GATE | PASSED | Accuracy: candidate 60.0%, original baseline 50.0%. |
| Cost stays within bound | HARD_GATE | PASSED | Steps per review: candidate 3, incumbent 2; at most 5× is allowed. |
| Review accuracy | WEIGHTED | PASSED | Accuracy changed by 0.1 (95% interval -0.05 to 0.25). |
| Severity-weighted harm | WEIGHTED | PASSED | Harm per review changed by -1.1. |
| Cost per review | WEIGHTED | FAILED | Steps per review changed by 1. |

## Known regressions

- nullability_added: 0/6 correct, down from 6/6 under the incumbent
- optional_field_added: 0/9 correct, down from 9/9 under the incumbent
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

Receipt hash: `9ce333fa4ea12cba5716ef62d4bfb8a0e99975912396d802268cb3806730b81a`
