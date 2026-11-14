# Improvement receipt rcpt_0mwgs5fupzne4c4efdf

> DETERMINISTIC FIXTURE EVALUATION — executable checks on synthetic cases; no model was run

**Decision: INCONCLUSIVE** — No demonstrated improvement: truly_correct_missions is no worse (95% interval 0 to 0, margin 0), but cost did not fall (worker_invocations_per_mission changed by 0.25), so the simplification saves nothing.

Decided by release-gate at 2026-11-14T19:09:46.754Z. Level: coordination. Experiment: `exp_0mwgs413l7h14f342b3`.

## Problem and supporting observations

Every mission with two workstreams spends a planning step agreeing a versioned interface before delivery starts. Integration is verified afterwards in any case.

Verified failure observations cited: 0.

## Hypothesis

If parallel workstreams start from the acceptance criteria and integration verification stays as it is, missions will finish with fewer worker invocations and no more defects reaching an accepted result.

Expected benefit: One fewer planning step per mission; delivery starts sooner.

Possible regressions stated in advance:
- The two workstreams interpret the shared record differently, which only shows at integration and has to be reworked
- More integration failures and a longer critical path when that happens

## Parent version and exact change

Parent: coordination v1 (`a2731e7d2ba012c8`). Candidate: `960ffabc860525de`.

Removes the interface-agreement step: no contract task, and delivery workstreams take the acceptance criteria as input instead of a pinned contract.

| File | Before | After |
|---|---|---|
| coordination.json | bfb286e494c7 | 1a90afe3cd57 |

## Evaluation

- Protocol: promotion-policy@1/coordination, frozen at 2026-11-14T19:08:40.977Z, before the candidate was submitted
- Policy hash: `a79f643c873bbd0d`
- Workload: mission-episodes:missions-B; snapshot:4b05cb9472cd4f6a594055807c9695736fb2f7533d36a45d1bd236262fc3601f
- Held-out set: missions-B
- Executor: mission-episodes (stochastic; rerun; 1 pass)

### Attempts

| # | Kind | Cases | Note |
|---|---|---|---|
| 1 | holdout | 8 | one evaluation on missions-B |

Resource use: 190 experiment units, 65774 ms, 0 model calls, cost not measured.

## Outcome differences and uncertainty

| Metric | Candidate | Incumbent | Baseline | Difference vs incumbent | 95% interval | n |
|---|---|---|---|---|---|---|
| truly_correct_missions (higher is better) | 1 | 1 | 1 | 0 | 0 to 0 | 8 |
| escaped_defects_per_mission (lower is better) | 0 | 0 | 0 | 0 | 0 to 0 | 8 |
| worker_invocations_per_mission (lower is better) | 12 | 11.75 | 11.75 | 0.25 | -0.5 to 0.75 | 8 |
| completion_ms (lower is better) | 4108.75 | 3550 | 3550 | 558.75 | 126.375 to 895.25 | 8 |
| rework_per_mission (lower is better) | 0.875 | 0.25 | 0.25 | 0.625 | 0.25 to 0.875 | 8 |
| integration_failures_per_mission (lower is better) | 0.625 | 0 | 0 | 0.625 | 0.25 to 0.875 | 8 |

Method for the primary metric: paired bootstrap over the same 8 mission episodes (20000 resamples, seeded); sign test: 0 better, 0 worse, 8 same, p=1.

## Gates

| Gate | Kind | Verdict | Meaning |
|---|---|---|---|
| Rules and records are intact | HARD_GATE | PASSED | The protected rules, held-out cases and records are byte-identical to the sealed state, before and after the evaluation. |
| No forbidden capabilities | HARD_GATE | PASSED | A coordination policy is data; the bundle contains no code that uses a forbidden capability. |
| Episodes are unseen by this lineage | HARD_GATE | PASSED | Run on episode set missions-B. |
| Enough episodes | HARD_GATE | PASSED | 8 episodes per arm; at least 6 are required. |
| Every mission reaches review | HARD_GATE | PASSED | 0 missions did not reach a reviewable state. |
| No more defects escape | HARD_GATE | PASSED | Acceptance criteria that fail on results the mission accepted: candidate 0, incumbent 0, across 8 episodes. |
| Truly correct missions | WEIGHTED | PASSED | Share of missions that are truly correct changed by 0. |
| Worker invocations per mission | WEIGHTED | FAILED | Worker invocations per mission changed by 0.25. |

## Known regressions

- 0.625 more integration failures per mission than under the incumbent

## Limitations

- Each episode is a complete fixture mission: the runtime, worker processes, merges and tests are real, the work content is scripted.
- A defect is injected into one worker's first attempt in about 50% of episodes. That rate is an assumption of this testbed; the size of any effect depends on it.
- The oracle is the same protected acceptance suite the verification swarm uses, so this measures what happens when nobody runs it — not whether it is a complete specification.
- 8 episodes per arm: intervals are wide.
- Where a policy has no interface agreement, the consuming workstream misreads the shared record in about 50% of episodes. That rate is also an assumption of this testbed. What the runtime measures is what each such mismatch costs and what the agreement step costs.

## Isolation

- Mode: **enforced** (operating-system user separation: yes, uid 65534; Node permission model: yes)
- Protected store intact before and after: yes
- candidate code runs as uid 65534; the protected store is owned by uid 0 with mode 0700

## Release

No release was created. The candidate and this result are kept.

Receipt hash: `c623d0652ada27f1c859cea60190e7b14f47792388f7095a262dbb32996cfdc1`
