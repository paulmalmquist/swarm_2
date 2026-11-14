# Improvement receipt rcpt_0mwgq3rhv7f151db04c

> DETERMINISTIC FIXTURE EVALUATION — executable checks on synthetic cases; no model was run

**Decision: REJECT** — Rejected: no more defects escape failed. Acceptance criteria that fail on results the mission accepted: candidate 5, incumbent 0, across 8 episodes.

Decided by release-gate at 2026-11-14T18:12:29.299Z. Level: coordination. Experiment: `exp_0mwgq2f7cka08b8f80e`.

## Problem and supporting observations

Every mission pays for a separate verification swarm even though delivery already runs its own tests at integration.

Verified failure observations cited: 0.

## Hypothesis

If the independent verification swarm is retired and delivery's own integration tests are trusted, missions will finish with fewer worker invocations and less time, with no more defects escaping.

Expected benefit: Fewer worker invocations and a shorter completion time per mission.

Possible regressions stated in advance:
- A defect that delivery's own tests do not cover would reach the review packet unverified

## Parent version and exact change

Parent: coordination v1 (`a2731e7d2ba012c8`). Candidate: `5326ad2f80a9e2b5`.

Sets independent_verification to false: no verification swarm is formed and the integrated result is accepted on delivery's own combined tests.

| File | Before | After |
|---|---|---|
| coordination.json | bfb286e494c7 | a6c56b7dc9a1 |

## Evaluation

- Protocol: promotion-policy@1/coordination, frozen at 2026-11-14T18:11:26.712Z, before the candidate was submitted
- Policy hash: `19b51d6fce298df7`
- Workload: mission-episodes:missions-A; snapshot:a71dd94684bff6b9a4c8b3b08659fbe85bf10d1c11e711d264d5f79ecc912d84
- Held-out set: missions-A
- Executor: mission-episodes (stochastic; rerun; 1 pass)

### Attempts

| # | Kind | Cases | Note |
|---|---|---|---|
| 1 | holdout | 8 | one evaluation on missions-A |

Resource use: 183 experiment units, 62584 ms, 0 model calls, cost not measured.

## Outcome differences and uncertainty

| Metric | Candidate | Incumbent | Baseline | Difference vs incumbent | 95% interval | n |
|---|---|---|---|---|---|---|
| truly_correct_missions (higher is better) | 0.375 | 1 | 1 | -0.625 | -0.875 to -0.25 | 8 |
| escaped_defects_per_mission (lower is better) | 0.625 | 0 | 0 | 0.625 | 0.25 to 0.875 | 8 |
| worker_invocations_per_mission (lower is better) | 10 | 12.875 | 12.875 | -2.875 | -3.625 to -1.75 | 8 |
| completion_ms (lower is better) | 3054 | 4195.125 | 4195.125 | -1141.125 | -1580.75 to -575 | 8 |
| rework_per_mission (lower is better) | 0 | 0.625 | 0.625 | -0.625 | -0.875 to -0.25 | 8 |

Method for the primary metric: paired bootstrap over the same 8 mission episodes (20000 resamples, seeded); sign test: 0 better, 5 worse, 3 same, p=0.0625.

## Gates

| Gate | Kind | Verdict | Meaning |
|---|---|---|---|
| Rules and records are intact | HARD_GATE | PASSED | The protected rules, held-out cases and records are byte-identical to the sealed state, before and after the evaluation. |
| No forbidden capabilities | HARD_GATE | PASSED | A coordination policy is data; the bundle contains no code that uses a forbidden capability. |
| Episodes are unseen by this lineage | HARD_GATE | PASSED | Run on episode set missions-A. |
| Enough episodes | HARD_GATE | PASSED | 8 episodes per arm; at least 6 are required. |
| Every mission reaches review | HARD_GATE | PASSED | 0 missions did not reach a reviewable state. |
| No more defects escape | HARD_GATE | FAILED | Acceptance criteria that fail on results the mission accepted: candidate 5, incumbent 0, across 8 episodes. |
| Truly correct missions | WEIGHTED | FAILED | Share of missions that are truly correct changed by -0.625. |
| Worker invocations per mission | WEIGHTED | PASSED | Worker invocations per mission changed by -2.875. |

## Known regressions

- 5 more defects reached an accepted result than under the incumbent

## Limitations

- Each episode is a complete fixture mission: the runtime, worker processes, merges and tests are real, the work content is scripted.
- A defect is injected into one worker's first attempt in about 50% of episodes. That rate is an assumption of this testbed; the size of any effect depends on it.
- The oracle is the same protected acceptance suite the verification swarm uses, so this measures what happens when nobody runs it — not whether it is a complete specification.
- 8 episodes per arm: intervals are wide.

## Isolation

- Mode: **enforced** (operating-system user separation: yes, uid 65534; Node permission model: yes)
- Protected store intact before and after: yes
- candidate code runs as uid 65534; the protected store is owned by uid 0 with mode 0700

## Release

No release was created. The candidate and this result are kept.

Receipt hash: `eb246d6b68ade2ea7f1e8cac9bf68e937923ba72704480c721a796106667fe6c`
