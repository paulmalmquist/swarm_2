# Demonstration H — Targeted comparisons against simpler configurations

> DETERMINISTIC FIXTURE PROVIDER — scripted workers in real processes; no model was run
> SYNTHETIC DATA — every request, team, dataset and value is invented
> INJECTED DEFECTS — in about half of the episodes one worker's first attempt carries a defect its own tests do not catch
> ASSUMED RATES — how often defects occur, and how often two workstreams disagree about an interface nobody agreed, are parameters of this testbed. The comparisons show what each coordination step catches and costs when those things happen; they do not show how often they happen in real work.

Does the independent verification swarm earn its cost? The question is put to the release gate as a coordination-level simplification: retire the verification swarm and trust delivery's own combined tests.
Each configuration runs the same eight seeded missions on the real runtime. Afterwards an oracle runs the protected acceptance suite on whatever each mission accepted.
Does the interface agreement before parallel work earn its step? The second simplification removes it: no contract task, and the two delivery workstreams start from the acceptance criteria alone.
Counting worker invocations only, the agreement pays for itself when the workstreams would otherwise disagree in more than about 50% of missions. In this fixture every invocation counts the same; real rework usually costs more than a planning step, which would lower that figure.

## What was checked

| Claim | Observed | Result |
|---|---|---|
| The simpler configuration is a coordination-level candidate with its own version | coordination v1 → candidate: Sets independent_verification to false: no verification swarm is formed and the integrated result is accepted on delivery's own combined tests. | held |
| Both configurations run the same seeded missions end to end | 8 complete fixture missions per configuration from held-out set missions-A; a defect is injected into a first attempt in about half of them | held |
| The simpler configuration really is cheaper and faster | worker invocations per mission 12.875 → 10; completion 4092 ms → 2995 ms | held |
| What it gives up is measured by an oracle, not assumed | defects reaching an accepted result per mission 0 → 0.625; truly correct missions 1 → 0.375 (difference -0.625, 95% interval -0.875 to -0.25) | held |
| The decision follows the frozen rule | reject: Rejected: no more defects escape failed. Acceptance criteria that fail on results the mission accepted: candidate 5, incumbent 0, across 8 episodes. | held |
| A second simplification is put to the same gate: no interface agreement before parallel work | Removes the interface-agreement step: no contract task, and delivery workstreams take the acceptance criteria as input instead of a pinned contract. Run on missions-B; the workstreams disagreed about the shared record in 5 of 8 episodes (an assumed rate). | held |
| The cost of the step and the cost of going without it are both measured | the agreement step costs 1 worker invocations and 137.67 ms per mission; a mission where the workstreams disagreed cost 1 more invocations and 939.4 ms more than the same mission with the agreement | held |
| Integration failures and quality are reported, not assumed | integration failures per mission 0 → 0.625; truly correct missions 1 → 1; invocations 11.75 → 12 (difference 0.25, 95% interval -0.5 to 0.75); completion 3411 ms → 3947 ms | held |
| The decision follows the frozen rule, whatever it is | inconclusive: No demonstrated improvement: truly_correct_missions is no worse (95% interval 0 to 0, margin 0), but cost did not fall (worker_invocations_per_mission changed by 0.25), so the simplification saves nothing. | held |

Files in this folder: `self-verification.receipt.json`, `self-verification.receipt.md`, `episodes.json`, `no-interface-agreement.receipt.json`, `no-interface-agreement.receipt.md`, `interface-agreement.json`.

Reproduce with `npm run demo:h`. Run time 124274 ms.
