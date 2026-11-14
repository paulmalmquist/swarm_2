# Demonstration G — Canary and rollback

> DETERMINISTIC FIXTURE PROVIDER — scripted workers in real processes; no model was run
> SYNTHETIC DATA — every request, team, dataset and value is invented
> INJECTED REGRESSION — a traffic shift toward a case class no evaluation set contained

An accepted release runs in a canary limited to two synthetic missions. Monitoring scores it on fresh cases and compares with what it scored when approved. The driver then shifts monitored traffic toward a safe change the accepted validator mishandles.

## What was checked

| Claim | Observed | Result |
|---|---|---|
| A qualified candidate is activated only in a bounded development canary | canary of 2 synthetic missions; new mission pinned to r2; the earlier mission stays on r1; default release still r1 | held |
| The canary is bounded | second mission took the last canary place; the next one got r1 | held |
| Monitoring on fresh cases finds nothing wrong at first | accuracy_drop_vs_approval=0; escaped_defect_rate_increase=0; canary_missions_with_acceptance_failures=0 | held |
| An injected regression is measured, not asserted | INJECTED: later traffic contains a kind of safe change no evaluation set had. accuracy_drop_vs_approval=0.2167 against a limit of 0.05 | held |
| The prior release is restored | active release r1; r2 marked rolled_back; new work is pinned to r1 | held |
| Missions, artifacts and memories that depended on the rolled-back version are identified | 2 missions (review_ready; planning, in flight), 12 artifacts, 4 memories | held |
| None of them is silently kept | artifacts marked needs_revalidation; memories invalidated with the reason "rollback of r2" | held |
| Migration of in-flight work is a deliberate, visible decision | one decision opened for the chief of staff about the in-flight mission: repin_and_redo or finish_quarantined | held |

Files in this folder: `canary.json`, `dependents.json`, `release-manifests.json`, `rollback-ledger.json`, `accepted-then-rolled-back.receipt.json`, `accepted-then-rolled-back.receipt.md`.

Reproduce with `npm run demo:g`. Run time 4040 ms.
