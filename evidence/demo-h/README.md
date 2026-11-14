# Demonstration H — Targeted comparison against a simpler configuration

> DETERMINISTIC FIXTURE PROVIDER — scripted workers in real processes; no model was run
> SYNTHETIC DATA — every request, team, dataset and value is invented
> INJECTED DEFECTS — in about half of the episodes one worker's first attempt carries a defect its own tests do not catch
> The defect rate is an assumption of this testbed. The comparison shows what the verification swarm catches when such defects occur, and what it costs; it does not show how often they occur in real work.

Does the independent verification swarm earn its cost? The question is put to the release gate as a coordination-level simplification: retire the verification swarm and trust delivery's own combined tests.
Each configuration runs the same eight seeded missions on the real runtime. Afterwards an oracle runs the protected acceptance suite on whatever each mission accepted.

## What was checked

| Claim | Observed | Result |
|---|---|---|
| The simpler configuration is a coordination-level candidate with its own version | coordination v1 → candidate: Sets independent_verification to false: no verification swarm is formed and the integrated result is accepted on delivery's own combined tests. | held |
| Both configurations run the same seeded missions end to end | 8 complete fixture missions per configuration from held-out set missions-A; a defect is injected into a first attempt in about half of them | held |
| The simpler configuration really is cheaper and faster | worker invocations per mission 12.875 → 10; completion 3978 ms → 2868 ms | held |
| What it gives up is measured by an oracle, not assumed | defects reaching an accepted result per mission 0 → 0.625; truly correct missions 1 → 0.375 (difference -0.625, 95% interval -0.875 to -0.25) | held |
| The decision follows the frozen rule | reject: Rejected: no more defects escape failed. Acceptance criteria that fail on results the mission accepted: candidate 5, incumbent 0, across 8 episodes. | held |

Files in this folder: `self-verification.receipt.json`, `self-verification.receipt.md`, `episodes.json`.

Reproduce with `npm run demo:h`. Run time 59232 ms.
