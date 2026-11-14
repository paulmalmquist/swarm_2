# Demonstration B — Failure recovery

> DETERMINISTIC FIXTURE PROVIDER — scripted workers in real processes; no model was run
> SYNTHETIC DATA — every request, team, dataset and value is invented
> INJECTED FAULTS — a killed worker, a stalled worker, a killed coordinator; each is labeled in the event log
> This demonstrates resilience. It is not evidence of general performance.

Coordinators run as separate operating-system processes so they can be killed like real ones. The driver kills a worker, lets another stall past its lease and submit late, kills the coordinator mid-mission and starts a new one, redelivers a command, and finally publishes a new version of the interface contract.

## What was checked

| Claim | Observed | Result |
|---|---|---|
| A killed worker loses ownership and the work is re-leased under a new fencing token | attempt 1 (pid 29817) is "killed"; the task is now on token g1a2 | held |
| A worker presumed dead cannot overwrite the attempt that replaced it | its lease expired without a heartbeat; it later presented token g1a1 and was rejected (task is accepted) | held |
| A new coordinator resumes from persisted state alone | the second coordinator fenced 1 in-flight attempt(s), finished the mission, and exited 0 | held |
| An orphaned worker is stopped rather than left running | pid 30007 outlived the coordinator that started it and was stopped on recovery | held |
| A duplicate delivery changes nothing, and a conflicting one is quarantined | 5 redelivered requests ignored; the repeated command returned the original mission; the conflicting one was refused: "Idempotency key demo-b-submit was reused with a different body" | held |
| Revising an upstream contract invalidates exactly what depended on it | delivery.engine.implement: rerun_required; delivery.integrate: downstream_blocked; reliability.knowledge: rerun_required; review.packet: downstream_blocked; delivery.report.implement: rerun_required | held |
| A review decision resting on stale evidence cannot be approved by mistake | the pending decision was superseded, its draft withdrawn, and the mission reopened | held |
| Only affected work is redone, and the result is verified again | discovery, criteria, plan and decomposition were not rerun; engine and report were rebuilt against contract v2; all 5 criteria pass again at generation 4 | held |
| State reconciles after all of it | budget tree reconciles; event chain intact; mission review_ready with a fresh decision requested | held |

Files in this folder: `timeline.txt`, `recovery.json`.

Reproduce with `npm run demo:b`. Run time 8309 ms.
