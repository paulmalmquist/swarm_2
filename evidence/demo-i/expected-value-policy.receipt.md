# Improvement receipt rcpt_0mwgxuthb1nc28cad92

> SIMULATION — a synthetic testbed; results describe the testbed, not real work

**Decision: ACCEPT** — Accepted: validated_benefit improved by 12.6167 against the incumbent (95% interval 0.4167 to 25.4333) with every hard gate passed.

Decided by release-gate at 2026-11-14T21:49:28.895Z. Level: evolution. Experiment: `exp_0mwgxufcl1j2729a7f2`.

## Problem and supporting observations

Improvement campaigns spend their budget on whatever is reported most often. Frequent complaints that were never verified, and fixes that would have failed a cheap check, consume budget that higher-value problems needed.

Verified failure observations cited: 0.

## Hypothesis

If the improvement process ranks problems by verified failures times severity per unit of cost, pilots a built fix on observed cases before paying for a held-out evaluation, and stops when no remaining problem is worth its cost, then with the same budget on unseen failure episodes it will deliver more independently validated harm reduction and spend less on experiments that fail.

Expected benefit: More validated harm reduction per fixed experiment budget; lower cost of failed experiments.

Possible regressions stated in advance:
- Pilots cost budget that could have funded another submission
- A problem with few verified failures but high latent harm is ranked low
- Stopping early leaves budget unused

## Parent version and exact change

Parent: evolution v1 (`d81a4b43a3303a68`). Candidate: `041479c9ba065b03`.

Replaces the frequency-first improvement policy with an expected-value policy: prioritization, a pilot step, pruning and a stopping rule all change.

| File | Before | After |
|---|---|---|
| evolution.json | 2b2dd7a24db2 | 266d3e869133 |
| policy.mjs | 6d87ca58fc8a | d5ce3450ca42 |

## Evaluation

- Protocol: promotion-policy@1/evolution, frozen at 2026-11-14T21:49:10.581Z, before the candidate was submitted
- Policy hash: `a79f643c873bbd0d`
- Workload: improvement-arena:arena-A; snapshot:7e1bfa7bc95fca27e3d3723f01bda552488a84b09270d0eb110d5f758cff89eb
- Held-out set: arena-A
- Executor: improvement-arena (deterministic; rerun; 1 pass)

### Attempts

| # | Kind | Cases | Note |
|---|---|---|---|
| 1 | development | 8 | development episodes run by the policy author |
| 2 | holdout | 30 | one evaluation on arena-A |

Resource use: 46866 experiment units, 16047 ms, 0 model calls, cost not measured.

## Outcome differences and uncertainty

| Metric | Candidate | Incumbent | Baseline | Difference vs incumbent | 95% interval | n |
|---|---|---|---|---|---|---|
| validated_benefit (higher is better) | 177.6167 | 165 | 165 | 12.6167 | 0.4167 to 25.4333 | 30 |
| validated_improvements (higher is better) | 2.0333 | 1.9 | 1.9 | 0.1333 | -0.0667 to 0.3667 | 30 |
| failed_experiment_cost (lower is better) | 120.0667 | 207.3333 | 207.3333 | -87.2667 | -113.3333 to -62.1333 | 30 |
| budget_spent (lower is better) | 372.8 | 411.3333 | 411.3333 | -38.5333 | -47.1333 to -29.5333 | 30 |
| validated_benefit_per_100_units (higher is better) | 47.8968 | 40.0359 | 40.0359 | 7.8609 | 5.1786 to 10.7089 | 30 |
| validated_benefit_without_unverified_complaints (higher is better) | 177.6167 | 172 | 172 | 5.6167 | -5.15 to 16.65 | 30 |

Method for the primary metric: paired bootstrap over the same 30 episodes (20000 resamples, seeded); sign test: 11 better, 2 worse, 17 same, p=0.02246.

## Gates

| Gate | Kind | Verdict | Meaning |
|---|---|---|---|
| Rules and records are intact | HARD_GATE | PASSED | The protected rules, held-out cases and records are byte-identical to the sealed state, before and after the evaluation. |
| No forbidden capabilities | HARD_GATE | PASSED | The policy code uses no file, process, network or dynamic-code capability. |
| Episodes are unseen by this lineage | HARD_GATE | PASSED | Run on episode set arena-A, which this lineage has not been scored on. |
| Enough episodes | HARD_GATE | PASSED | 30 episodes run; at least 20 are required. |
| The experiment budget is respected | HARD_GATE | PASSED | Episodes over budget: 0. Actions the arena had to refuse (unaffordable or malformed): 0. |
| Every campaign ends on its own | HARD_GATE | PASSED | Campaigns that hit the step limit or failed: 0. |
| Validated benefit at equal budget | WEIGHTED | PASSED | Validated benefit changed by 12.6167 (95% interval 0.4167 to 25.4333). |
| Cost of failed experiments | WEIGHTED | PASSED | Budget spent on fixes that failed changed by -87.2667 units per campaign. |

## Known regressions

- In 2 of 30 episodes the candidate policy delivered less validated benefit than the incumbent
- Without the unverified complaint class the advantage is not demonstrated (difference 5.6167, 95% interval -5.15 to 16.65)

## Limitations

- The arena is a synthetic testbed. Its failure distribution is invented and its fix library stands in for hypothesis generation; the result describes behaviour in this testbed, not improvement rates in real work.
- By construction the arena contains a frequently reported, never verified complaint class. The comparison is repeated without it as a sensitivity check; only the main comparison decides.
- Policies and validators are deterministic, so each episode is run once. The interval reflects which episodes were drawn.
- Both policies were written by the same author who built the arena.

## Isolation

- Mode: **enforced** (operating-system user separation: yes, uid 65534; Node permission model: yes)
- Protected store intact before and after: yes
- candidate code runs as uid 65534; the protected store is owned by uid 0 with mode 0700

## Release

Release **r2** (canary; evidence basis: simulation; parent r1)

| Level | Version | Content hash |
|---|---|---|
| execution | v1 | `bfbd9eb006fa426e` |
| coordination | v1 | `a2731e7d2ba012c8` |
| evolution | v2 | `041479c9ba065b03` |

Policy hash `a79f643c873bbd0d`; evaluation snapshot `7e1bfa7bc95fca27`; receipt rcpt_0mwgxuthb1nc28cad92; manifest hash `662f975fec62795c`.

Rollback target: r1.

Receipt hash: `7e73fbf62b94f8297dc2a6ab7d71a01bbcf2c07b8ccd4883ab65ef1457980dcf`
