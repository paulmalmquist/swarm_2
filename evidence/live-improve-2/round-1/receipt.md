# Improvement receipt rcpt_0mwgrx8wt0j3e25d391

> DETERMINISTIC FIXTURE EVALUATION — executable checks on synthetic cases; no model was run

**Decision: REJECT** — Rejected: safe changes are not blocked failed. Share of safe changes blocked: candidate 10.0%, incumbent 0.0%; allowed margin 5.0%.

Decided by release-gate at 2026-11-14T19:03:24.509Z. Level: execution. Experiment: `exp_0mwgrx8lb0f2c55a7e9`.

## Problem and supporting observations

Reviews with release r1 got 13 of 40 development reviews wrong: type_changed×3, field_removed×4, field_renamed×3, required_added×2, enum_value_removed×1.

Verified failure observations cited: 13 (for example `obs_0mwgrvids0115c2485c`, `obs_0mwgrvids023938e9b9`, `obs_0mwgrvids0343da4350`).

## Hypothesis

If the change-review skill also compares contract_before and contract_after field by field (recursing into nested objects and array items) and blocks consumer-breaking differences, then breaking changes that are currently approved will be sent back with the correct field named. That covers removed or renamed fields, type changes, newly required fields, removed enum values, unit or format changes and tightened constraints. Doc-only changes and added optional fields should still be approved. Measured result: development accuracy went from about 0.675 on the observed sample to 1.0 on the 60 dev cases, with 0 of 38 breaking changes approved and 0 of 22 safe changes blocked.

Expected benefit: Fewer approved breaking changes, with safe changes still approved.

Possible regressions stated in advance:
- Safe changes could be blocked
- Each review runs one more step
- The dev cases only contain type_changed, field_removed, field_renamed, required_added and enum_value_removed as breaking kinds, and doc-only, optional-field-added and no-contract-change as safe kinds. Every other rule (units, formats, constraints, nullability, required to optional, enum additions, composition keywords) is untested against labels.
- When the label is ambiguous (making a field nullable or optional, adding an enum value), I chose to block when in doubt because the gate allows no extra escapes but some margin on false alarms. The held-out labelling convention may differ.
- Field-path convention for nested and array fields: I use dot paths such as 'tolerance.lower' and leave out 'items' for arrays. If the held-out scorer expects 'items' or '[]' in the path, nested array findings may count as the wrong field.

## Parent version and exact change

Parent: execution v1 (`bfbd9eb006fa426e`). Candidate: `1e280938a1dd3044`.

Added candidate/validators/interface_compat.mjs, a plain-JS check with no imports. It walks both schemas recursively and builds dot paths from the root, skipping 'items' for arrays. BLOCKING findings: a property removed (reported under the old path); a rename, detected when a removed field and an added field have the same schema once documentation is ignored, reported only under the old path; any change to the set of allowed types, including adding null or nullable:true; a new required field, or an optional field made required; a required field made optional; an enum value removed, an enum added to a field that had none, or a const changed; x-unit/unit, format or content encoding changed; a constraint tightened (min/max, length, item count, pattern, multipleOf, uniqueItems, additionalProperties:false); a non-documentation change to oneOf/anyOf/allOf/not/$ref or to a non-object items schema. ADVISORY only: an enum value added, a constraint loosened, an enum or const removed, a default changed, a unit annotation added or dropped. IGNORED: description, title, examples, $comment and key order. Ran `node check.mjs`: accuracy 1.0, breaking changes approved 0 of 38, safe changes blocked 0 of 22, no errors.

| File | Before | After |
|---|---|---|
| execution.json | 623fb23304c6 | cb23b3afd9b3 |
| validators/interface_compat.mjs | new | fb3222308f04 |

## Evaluation

- Protocol: promotion-policy@1/execution, frozen at 2026-11-14T19:03:24.095Z, before the candidate was submitted
- Policy hash: `a79f643c873bbd0d`
- Workload: review:holdout-A; snapshot:6a18cfc3316a89197c81c03f84ce657d8bf057ea465f3d7158201b7174f20f9e
- Held-out set: holdout-A
- Executor: validator-executor (deterministic; rerun; 1 pass)

### Attempts

| # | Kind | Cases | Note |
|---|---|---|---|
| 1 | development | 40 | development check by the candidate author |
| 2 | holdout | 80 | one evaluation on holdout-A |

Resource use: 281 experiment units, 342 ms, 0 model calls, cost not measured.

## Outcome differences and uncertainty

| Metric | Candidate | Incumbent | Baseline | Difference vs incumbent | 95% interval | n |
|---|---|---|---|---|---|---|
| accuracy (higher is better) | 0.9625 | 0.5 | 0.5 | 0.4625 | 0.3375 to 0.5875 | 80 |
| harm_per_review (lower is better) | 0.0375 | 2.5 | 2.5 | -2.4625 | -3.0625 to -1.8625 | 80 |
| escaped_defect_rate (lower is better) | 0 | 0.8 | 0.8 | -0.8 | — | 80 |
| false_alarm_rate (lower is better) | 0.1 | 0 | 0 | 0.1 | — | 80 |
| steps_per_review (lower is better) | 3 | 2 | 2 | 1 | 1 to 1 | 80 |
| wall_ms_per_review (lower is better) | 0.244 | 0.138 | 0.15 | 0.106 | — | 80 |

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

Receipt hash: `34356d7f9a6588559a3fcf65038bcc511a2c6d9a4f5d900e9e7fadcb77d1927f`
