# Improvement receipt rcpt_0mwgrz8mw0p9ce32e0e

> DETERMINISTIC FIXTURE EVALUATION — executable checks on synthetic cases; no model was run

**Decision: ACCEPT** — Accepted: accuracy improved by 0.5125 against the incumbent (95% interval 0.4 to 0.625) with every hard gate passed.

Decided by release-gate at 2026-11-14T19:04:57.464Z. Level: execution. Experiment: `exp_0mwgrz8c50ldb0dae10`.

## Problem and supporting observations

Reviews with release r1 got 13 of 40 development reviews wrong: type_changed×3, field_removed×4, field_renamed×3, required_added×2, enum_value_removed×1.

Verified failure observations cited: 13 (for example `obs_0mwgrvids0115c2485c`, `obs_0mwgrvids023938e9b9`, `obs_0mwgrvids0343da4350`).

## Hypothesis

If interface_compat blocks only changes that stop a previously valid value or record from being valid (a type swapped or narrowed, a field removed or renamed, a field made required, an enum value removed, a constraint tightened, a oneOf/anyOf alternative dropped) and makes widening changes advisory (type widened or made nullable, a required field made optional, an explicit type added that the existing enum already satisfies, a format added, oneOf/anyOf alternatives added, a draft-4 exclusive flag relaxed), then the share of held-out safe changes blocked will drop from 0.10 to 0.05 or less (no more than incumbent + 0.05). Breaking changes approved should stay near 0, because every breaking class seen in dev and in observed failures (type swap, field removed, field renamed, required added, enum value removed) is still blocked.

Expected benefit: Fewer approved breaking changes, with safe changes still approved.

Possible regressions stated in advance:
- Safe changes could be blocked
- Each review runs one more step
- I don't know which safe class caused the 10% false-alarm rate. My leading guesses are type widening/nullable and required -> optional, and I relaxed several possible causes at once. Each relaxation trades some risk of approving breaking changes for fewer false alarms.
- The dev set has no cases of type widening, required -> optional, format addition, oneOf/anyOf edits, or draft-4 exclusive flags, so none of the new branches is exercised by `node check.mjs`.
- Ad-hoc execution beyond `node check.mjs` was denied, so the new code paths (covers/valueType, the composition handling) have not been run against hand-built inputs.

## Parent version and exact change

Parent: execution v1 (`bfbd9eb006fa426e`). Candidate: `6a71e5e51256aacf`.

Revised candidate/validators/interface_compat.mjs in place. (1) Type check: it now blocks only when a type that was allowed before is no longer allowed (integer counts as covered by number). A pure widening, such as adding a type or making a field nullable, is now advisory 'type_widened'. (2) Adding an explicit type to a field that had only enum/const is advisory when every existing value already has that type. Before, any newly stated type blocked. (3) Making a required field optional (required_removed) is now advisory instead of blocking. (4) A newly added format is advisory. Changing one format or unit value to another still blocks. (5) A draft-4 boolean exclusiveMinimum/Maximum blocks only when it goes from false or absent to true. Relaxing it is advisory. (6) oneOf/anyOf: adding alternatives is advisory. Dropping or changing an alternative, or adding a new oneOf/anyOf, still blocks. Removing the keyword is advisory. Any change to allOf, not or $ref still blocks. I updated the header comment to match. Result of `node check.mjs`: 60 cases, accuracy 1.0, 0 of 38 breaking changes approved, 0 of 22 safe changes blocked, no errors. Limitation: running anything other than `node check.mjs` was denied in this environment, so I could not run ad-hoc tests of the new widening branches. They are checked by reading the code only, not by execution.

| File | Before | After |
|---|---|---|
| execution.json | 623fb23304c6 | bd0f00d711d8 |
| validators/interface_compat.mjs | new | e4af180b34df |

## Evaluation

- Protocol: promotion-policy@1/execution, frozen at 2026-11-14T19:04:57.078Z, before the candidate was submitted
- Policy hash: `a79f643c873bbd0d`
- Workload: review:holdout-B; snapshot:6c1f94f3af10fc2f5fd8d091b3b03e4b36f6f898c312d1d15294f7792a6ab2f5
- Held-out set: holdout-B
- Executor: validator-executor (deterministic; rerun; 1 pass)

### Attempts

| # | Kind | Cases | Note |
|---|---|---|---|
| 1 | development | 40 | development check by the candidate author |
| 2 | holdout | 80 | one evaluation on holdout-B |

Resource use: 281 experiment units, 333 ms, 0 model calls, cost not measured.

## Outcome differences and uncertainty

| Metric | Candidate | Incumbent | Baseline | Difference vs incumbent | 95% interval | n |
|---|---|---|---|---|---|---|
| accuracy (higher is better) | 1 | 0.4875 | 0.4875 | 0.5125 | 0.4 to 0.625 | 80 |
| harm_per_review (lower is better) | 0 | 2.4 | 2.4 | -2.4 | -2.975 to -1.85 | 80 |
| escaped_defect_rate (lower is better) | 0 | 0.9535 | 0.9535 | -0.9535 | — | 80 |
| false_alarm_rate (lower is better) | 0 | 0 | 0 | 0 | — | 80 |
| steps_per_review (lower is better) | 3 | 2 | 2 | 1 | 1 to 1 | 80 |
| wall_ms_per_review (lower is better) | 0.238 | 0.123 | 0.135 | 0.114 | — | 80 |

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
| execution | v2 | `6a71e5e51256aacf` |
| coordination | v1 | `a2731e7d2ba012c8` |
| evolution | v1 | `d81a4b43a3303a68` |

Policy hash `a79f643c873bbd0d`; evaluation snapshot `6c1f94f3af10fc2f`; receipt rcpt_0mwgrz8mw0p9ce32e0e; manifest hash `73e60b98b50e7c97`.

Rollback target: r1.

Receipt hash: `0c950dc26d0b319a7de27769179852202588d2f5f64fd41f3b95340c79612981`
