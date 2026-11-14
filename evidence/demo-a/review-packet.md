# Review packet: Shared dataset-health capability

> DETERMINISTIC FIXTURE RUN · SYNTHETIC DATA · release r1

This packet covers "Shared dataset-health capability". 5 of 5 acceptance criteria passed independent verification.
Decide whether to approve the merge request draft. Approval records your decision; it does not merge anything.

## Context

Give every team one policy-driven way to see which datasets are stale, drifting or unmeasured, and who owns them.

## Requests consolidated

- **Propulsion Test** (syn-ana-propulsion, `syn-req-001`): Our hotfire review dashboard silently showed three day old engine test data last week. We need to know when the engine_test_runs dataset is stale, with a 60 minute threshold, before every review.
- **Supply Chain Analytics** (syn-ben-supplychain, `syn-req-002`): The BOM cost dashboard broke when an upstream column was renamed and nobody noticed for days. We need a check that compares each table schema against its declared contract and reports drift by field.
- **Manufacturing Quality** (syn-chloe-quality, `syn-req-003`): For the weekly ops review I need an SLA report on the freshness of our NCR tables, grouped by owner team. If a dataset has never been measured it must say unknown, not look fresh.
- **Forward Deployed Engineering** (syn-dev-fde, `syn-req-004`): Three forward deployed engineers each hand-rolled their own dataset freshness checks with different thresholds. We want one shared, reusable capability where thresholds are policy configuration, not code.

Shared capability: A shared, policy-driven dataset-health capability: freshness against per-dataset thresholds and schema conformance against declared fields, with an SLA report and alerts

### Distinct needs preserved

- syn-ana-propulsion: Know when a dataset is older than its own threshold, and be alerted before a review → AC-FRESH-PROPULSION (satisfied)
- syn-ben-supplychain: Detect schema drift against a declared contract and name the fields involved → AC-SCHEMA-SUPPLY (satisfied)
- syn-chloe-quality: An SLA report grouped by owner team that shows an unmeasured dataset as unknown → AC-SLA-QUALITY (satisfied)
- syn-dev-fde: One shared capability whose thresholds are policy configuration rather than code → AC-POLICY-FDE (satisfied)

## Exact changes

Base `58690ac4c8` → head `685cc5afdf` on `integration`

- A contracts/health-record.schema.json
- A src/engine/evaluate.ts
- A src/report/report.ts
- A test/engine/evaluate.test.ts
- A test/report/report.test.ts

## Acceptance evidence

| Criterion | For | Verdict | Independent | Evidence |
|---|---|---|---|---|
| AC-FRESH-PROPULSION: A dataset older than its own threshold is reported stale and raises an alert | syn-ana-propulsion | pass | yes | evd_0mwgqki3z6g6c7ecb50 |
| AC-SCHEMA-SUPPLY: An upstream column rename is reported as schema drift naming the missing and unexpected fields | syn-ben-supplychain | pass | yes | evd_0mwgqki3z6g6c7ecb50 |
| AC-SLA-QUALITY: The SLA report groups datasets by owner team and shows an unmeasured dataset as unknown, never as zero or fresh | syn-chloe-quality | pass | yes | evd_0mwgqki3z6g6c7ecb50 |
| AC-POLICY-FDE: Thresholds come from policy configuration; changing only the policy changes the result | syn-dev-fde | pass | yes | evd_0mwgqki3z6g6c7ecb50 |
| AC-CONTRACT: Every health record conforms to the pinned HealthRecord contract | all | pass | yes | evd_0mwgqki3z6g6c7ecb50 |

## Remaining concerns

- Drift detection compares declared and observed type names literally
- Actual load cadences are not given; thresholds are taken from the requests where stated
- Whether an alert should page someone or only appear in a report is not stated
- No request says how long drift may persist before it matters
- The contract carries no severity ranking; the weekly review may want one
- Thresholds in the criteria come from the requests and have not been confirmed by dataset owners
- Open question from agt_0mwgqkgaq0u11b9e9d1: Should a stale-data alert page someone, or only appear in the report? No request says.

## Decision requested

Approve the integrated result of "Shared dataset-health capability" for merge into the protected branch?

Options: approve, request_changes, reject.
Approval marks the merge request draft approved. The merge itself stays with the existing protected path.

## Resource use

- Worker invocations: 10
- Model calls: 0
- Tokens: 0
- Cost: not measured
- Worker wall time: 930 ms
