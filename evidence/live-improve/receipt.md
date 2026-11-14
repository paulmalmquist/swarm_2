# Improvement receipt rcpt_0mwgrtvmf0ja5028598

> DETERMINISTIC FIXTURE EVALUATION — executable checks on synthetic cases; no model was run

**Decision: REJECT** — Rejected: safe changes are not blocked failed. Share of safe changes blocked: candidate 10.0%, incumbent 0.0%; allowed margin 5.0%.

Decided by release-gate at 2026-11-14T19:00:47.319Z. Level: execution. Experiment: `exp_0mwgrtv940faffd3d44`.

## Problem and supporting observations

Reviews with release r1 got 13 of 40 development reviews wrong: type_changed×3, field_removed×4, field_renamed×3, required_added×2, enum_value_removed×1.

Verified failure observations cited: 13 (for example `obs_0mwgrrubw014f36b082`, `obs_0mwgrrubw02bc72a0f7`, `obs_0mwgrruby03bf3a9e45`).

## Hypothesis

If the change-review skill also runs interface_compat (a recursive structural diff of contract_before vs contract_after that blocks removed/renamed fields, type changes, unit/format/constraint changes, enum value removals, and requiredness changes while treating annotation-only changes and new optional fields as safe), then breaking interface changes (type_changed, field_removed, field_renamed, required_added, enum_value_removed and similar unseen kinds such as unit or nested-field changes) will be sent back with the correct dot-path field, raising accuracy above the current ~0.675 without increasing blocked safe changes; this is falsified if held-out accuracy does not rise, any breaking change is approved, or safe changes are blocked beyond the margin.

Expected benefit: Fewer approved breaking changes, with safe changes still approved.

Possible regressions stated in advance:
- Safe changes could be blocked
- Each review runs one more step
- The development cases only contain top-level field changes; nested-path handling (e.g. tolerance.lower) is untested against labels
- Held-out change kinds (unit changes, nullability, bound changes, enum additions, format changes) have unknown labels; severity choices for them are judgment calls
- The list of meaning-bearing x- extensions is a heuristic; unrecognised extensions that change meaning would only be advisory

## Parent version and exact change

Parent: execution v1 (`bfbd9eb006fa426e`). Candidate: `3e2726574083d63d`.

Added candidate/validators/interface_compat.mjs (id 'interface_compat'). It walks both schemas recursively through properties and items, building dot paths from the contract root. Blocking: field removed (reported as field_renamed if an added field has an identical schema), type set changed (including nullable), enum value removed / enum added / enum dropped, const changed, field became required or new required field, field became optional, and changes to non-annotation keywords such as x-unit, format, minimum/maximum, length, pattern, additionalProperties, plus x- extensions whose names suggest meaning (unit, scale, precision, timezone, currency, etc.). Advisory only: optional field added, enum value added, default changed, other x- extensions. Ignored: description, title, examples, deprecated and similar annotations. Development check: accuracy 1.0 (60/60), 0 of 38 breaking approved, 0 of 22 safe blocked, no errors.

| File | Before | After |
|---|---|---|
| execution.json | 623fb23304c6 | 93db22b784c8 |
| validators/interface_compat.mjs | new | f3f93d03d7d7 |

## Evaluation

- Protocol: promotion-policy@1/execution, frozen at 2026-11-14T19:00:46.840Z, before the candidate was submitted
- Policy hash: `a79f643c873bbd0d`
- Workload: review:holdout-A; snapshot:1f54b82a3df3a22a1907cb83fbcf05af3eb300df9944b1489913d3d710c77e6d
- Held-out set: holdout-A
- Executor: validator-executor (deterministic; rerun; 1 pass)

### Attempts

| # | Kind | Cases | Note |
|---|---|---|---|
| 1 | development | 40 | development check by the candidate author |
| 2 | holdout | 80 | one evaluation on holdout-A |

Resource use: 281 experiment units, 376 ms, 0 model calls, cost not measured.

## Outcome differences and uncertainty

| Metric | Candidate | Incumbent | Baseline | Difference vs incumbent | 95% interval | n |
|---|---|---|---|---|---|---|
| accuracy (higher is better) | 0.9625 | 0.5 | 0.5 | 0.4625 | 0.3375 to 0.5875 | 80 |
| harm_per_review (lower is better) | 0.0375 | 2.5 | 2.5 | -2.4625 | -3.075 to -1.8625 | 80 |
| escaped_defect_rate (lower is better) | 0 | 0.8 | 0.8 | -0.8 | — | 80 |
| false_alarm_rate (lower is better) | 0.1 | 0 | 0 | 0.1 | — | 80 |
| steps_per_review (lower is better) | 3 | 2 | 2 | 1 | 1 to 1 | 80 |
| wall_ms_per_review (lower is better) | 0.193 | 0.141 | 0.153 | 0.052 | — | 80 |

Method for the primary metric: paired bootstrap over the same 80 cases (20000 resamples, seeded); sign test: 40 better, 3 worse, 37 same, p=0.

## Gates

| Gate | Kind | Verdict | Meaning |
|---|---|---|---|
| Rules and records are intact | HARD_GATE | PASSED | The protected rules, held-out cases and records are byte-identical to the sealed state, before and after the evaluation. |
| No forbidden capabilities | HARD_GATE | PASSED | The candidate code uses no file, process, network or dynamic-code capability. |
| Held-out cases are unseen by this lineage | HARD_GATE | PASSED | Scored on holdout-A, which this candidate lineage has not been scored on before. |
| Required verification steps are performed | HARD_GATE | PASSED | Every step that may not be omitted fired on its probe case. |
| Enough scored cases | HARD_GATE | PASSED | 80 cases scored; at least 40 are required. |
| No more defects escape | HARD_GATE | PASSED | Share of breaking changes approved: candidate 0.0%, incumbent 80.0%. |
| Safe changes are not blocked | HARD_GATE | FAILED | Share of safe changes blocked: candidate 10.0%, incumbent 0.0%; allowed margin 5.0%. |
| No cumulative regression against the original baseline | HARD_GATE | PASSED | Accuracy: candidate 96.3%, original baseline 50.0%. |
| Cost stays within bound | HARD_GATE | PASSED | Steps per review: candidate 3, incumbent 2; at most 5× is allowed. |
| Review accuracy | WEIGHTED | PASSED | Accuracy changed by 0.4625 (95% interval 0.3375 to 0.5875). |
| Severity-weighted harm | WEIGHTED | PASSED | Harm per review changed by -2.4625. |
| Cost per review | WEIGHTED | FAILED | Steps per review changed by 1. |

## Known regressions

- nullability_added: 3/6 correct, down from 6/6 under the incumbent
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

Receipt hash: `f9a7f9e995e570f31a7aa034675aede20780360bd9e918b45fa390e89b51f052`
