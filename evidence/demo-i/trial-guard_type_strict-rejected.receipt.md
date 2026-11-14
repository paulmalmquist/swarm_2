# Improvement receipt rcpt_0mwgxuuh83fddbfb628

> DETERMINISTIC FIXTURE EVALUATION — executable checks on synthetic cases; no model was run

**Decision: REJECT** — Rejected: safe changes are not blocked failed. Share of safe changes blocked: candidate 13.5%, incumbent 0.0%; allowed margin 5.0%.

Decided by release-gate at 2026-11-14T21:49:30.188Z. Level: execution. Experiment: `exp_0mwgxuu7g3bd5d60efd`.

## Problem and supporting observations

Review failures recorded under r1: type_changed (3 verified, 0 unverified reports).

Verified failure observations cited: 3 (for example `obs_0mwgxutio1r27463c61`, `obs_0mwgxutip1wb3cd2cb3`, `obs_0mwgxutip204e9dcb91`).

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

- Protocol: promotion-policy@1/execution, frozen at 2026-11-14T21:49:29.837Z, before the candidate was submitted
- Policy hash: `a79f643c873bbd0d`
- Workload: review:holdout-B; snapshot:8b027f7a1a9294116d91728082051507a8e2ec63287a424a4033e3b504b5c1ad
- Held-out set: holdout-B
- Executor: validator-executor (deterministic; rerun; 1 pass)

### Attempts

| # | Kind | Cases | Note |
|---|---|---|---|
| 1 | development | 40 | development check by the candidate author |
| 2 | holdout | 80 | one evaluation on holdout-B |

Resource use: 281 experiment units, 273 ms, 0 model calls, cost not measured.

## Outcome differences and uncertainty

| Metric | Candidate | Incumbent | Baseline | Difference vs incumbent | 95% interval | n |
|---|---|---|---|---|---|---|
| accuracy (higher is better) | 0.55 | 0.4875 | 0.4875 | 0.0625 | -0.025 to 0.1625 | 80 |
| harm_per_review (lower is better) | 1.9875 | 2.4 | 2.4 | -0.4125 | -0.725 to -0.1375 | 80 |
| escaped_defect_rate (lower is better) | 0.7209 | 0.9535 | 0.9535 | -0.2326 | — | 80 |
| false_alarm_rate (lower is better) | 0.1351 | 0 | 0 | 0.1351 | — | 80 |
| steps_per_review (lower is better) | 3 | 2 | 2 | 1 | 1 to 1 | 80 |
| wall_ms_per_review (lower is better) | 0.11 | 0.108 | 0.107 | 0.003 | — | 80 |

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

Receipt hash: `12659f24b86ac30023d11aa74678c597324d7591d352000b6258d4722b2a4203`
