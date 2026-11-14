# Demonstration A — Cross-swarm delivery

> DETERMINISTIC FIXTURE PROVIDER — scripted workers in real processes; no model was run
> SYNTHETIC DATA — every request, team, dataset and value is invented

Five synthetic requests arrive. Four describe different symptoms of one missing capability; one is unrelated. The chief of staff submits the nominated mission.
Discovery establishes the shared need and each stakeholder's distinct need. Planning writes measurable acceptance criteria, agrees the HealthRecord interface and proposes the work graph. The delivery lead creates two subordinate teams that work at the same time in separate git worktrees and meet at one integration task. A separate verification swarm runs a protected acceptance suite on a clean checkout. Reliability records what was learned. The review packet asks for one decision.

## What was checked

| Claim | Observed | Result |
|---|---|---|
| Overlapping requests are nominated and the unrelated one is left out | one cluster of syn-req-001, syn-req-002, syn-req-003, syn-req-004; syn-req-005 (licensing) not included | held |
| The mission runs to a reviewable state | coordinator idle; mission review_ready; 18/18 tasks accepted | held |
| At least three swarm capabilities take part | 5 participated: discovery, planning, delivery, verification, reliability | held |
| The organization uses three delegated layers and no more | deepest task is at layer 3; subordinate teams: Implement the evaluation engine that produces HealthRecords / Implement the SLA report and alerts that consume HealthRecords | held |
| Each stakeholder keeps a distinct need tied to its own acceptance criterion | syn-ana-propulsion→AC-FRESH-PROPULSION (satisfied); syn-ben-supplychain→AC-SCHEMA-SUPPLY (satisfied); syn-chloe-quality→AC-SLA-QUALITY (satisfied); syn-dev-fde→AC-POLICY-FDE (satisfied) | held |
| Two workstreams execute concurrently | engine leased #91 2026-11-14T18:10:47.736Z → submitted #94; report leased #92 2026-11-14T18:10:47.874Z → submitted #97 | held |
| Workers actually execute as separate processes in isolated worktrees | 8 worker attempts in 8 distinct processes; worktree branches: task/delivery-engine-implement/g1a1, task/delivery-report-implement/g1a1 | held |
| The workstreams meet at a real integration boundary | delivery.engine.implement merged as ae11c9f114; delivery.report.implement merged as cba66c9968 | held |
| The integrated result is verified independently of its authors | AC-FRESH-PROPULSION=pass, AC-SCHEMA-SUPPLY=pass, AC-SLA-QUALITY=pass, AC-POLICY-FDE=pass, AC-CONTRACT=pass by the verification swarm, on tests delivery never saw | held |
| Handoffs carry the artifact version, acceptance evidence and remaining uncertainty | 3 handoffs, all accepted by the next owner; 1 carried stated uncertainty | held |
| A review packet and the decision it needs are waiting for the chief of staff | decision: Approve the integrated result of "Shared dataset-health capability" for merge into the protected branch? \| draft: Merge request: Shared dataset-health capability | held |
| Resource accounting reconciles across the whole task tree | 24 accounts reconcile; 11 worker invocations and 1136 ms of worker time used | held |
| Everything shown comes from the persisted, hash-chained event log | 158 events, chain intact | held |
| Approval is recorded and nothing is merged or sent by the system | mission completed; draft approved; sent_by_swarm=false | held |

Files in this folder: `review-packet.md`, `review-packet.json`, `organization.json`, `lineage.json`, `outcome.json`, `timeline.txt`.

Reproduce with `npm run demo:a`. Run time 3479 ms.
