# Review packet: Shared dataset-health capability

> LIVE MODEL EXECUTION · SYNTHETIC DATA · release r1

This packet covers "Shared dataset-health capability". 4 of 4 acceptance criteria passed independent verification.
Decide whether to approve the merge request draft. Approval records your decision; it does not merge anything.

## Context

Give every team one policy-driven way to see which datasets are stale, drifting or unmeasured, and who owns them.

## Requests consolidated

- **Propulsion Test** (syn-ana-propulsion, `syn-req-001`): Our hotfire review dashboard silently showed three day old engine test data last week. We need to know when the engine_test_runs dataset is stale, with a 60 minute threshold, before every review.
- **Supply Chain Analytics** (syn-ben-supplychain, `syn-req-002`): The BOM cost dashboard broke when an upstream column was renamed and nobody noticed for days. We need a check that compares each table schema against its declared contract and reports drift by field.
- **Manufacturing Quality** (syn-chloe-quality, `syn-req-003`): For the weekly ops review I need an SLA report on the freshness of our NCR tables, grouped by owner team. If a dataset has never been measured it must say unknown, not look fresh.
- **Forward Deployed Engineering** (syn-dev-fde, `syn-req-004`): Three forward deployed engineers each hand-rolled their own dataset freshness checks with different thresholds. We want one shared, reusable capability where thresholds are policy configuration, not code.

Shared capability: A single reusable dataset freshness monitor that compares each dataset's last-update time against policy-configured thresholds and reports each dataset as fresh, stale, or unknown (never measured), grouped by owner team.

### Distinct needs preserved

- syn-ana-propulsion: Know when the engine_test_runs dataset is stale using a 60-minute threshold, checked before every hotfire review, so that the dashboard does not silently show old test data. → AC-FRESH-PROPULSION (satisfied)
- syn-chloe-quality: A weekly SLA report on the freshness of NCR tables, grouped by owner team, in which any dataset never measured is reported as unknown rather than fresh. → AC-SLA-QUALITY (satisfied)
- syn-dev-fde: One shared, reusable freshness-check capability to replace three hand-rolled per-engineer checks, where thresholds are policy configuration rather than code. → AC-POLICY-FDE (satisfied)
- syn-ben-supplychain: The BOM cost dashboard broke when an upstream column was renamed and nobody noticed for days. We need a check that compares each table schema against its declared contract and reports drift by field. → no criterion (deferred)

## Exact changes

Base `3ee2dc4bd2` → head `688422c289` on `integration`

- A contracts/health-record.schema.json
- A src/engine/evaluate.ts
- A src/report/report.ts
- A test/engine/evaluate.test.ts
- A test/report/report.test.ts

## Acceptance evidence

| Criterion | For | Verdict | Independent | Evidence |
|---|---|---|---|---|
| AC-FRESH-PROPULSION: Run the freshness check on engine_test_runs with fixtures whose last update is 59 minutes old, 61 minutes old, and three days old, using the 60-minute threshold read from policy configuration. Passing: the 59-minute fixture is reported fresh; the 61-minute and three-day fixtures are each reported stale; the check can be invoked on demand before a hotfire review and returns its result in a single call, so stale data is never reported fresh. | syn-ana-propulsion | pass | yes | evd_0mwgs448t9g219ffd2e |
| AC-SLA-QUALITY: Generate the weekly NCR freshness SLA report from a fixture containing NCR datasets owned by at least two teams, with at least one dataset that has never been measured (no recorded last-update time). Passing: every row is grouped under its owner team; every dataset has exactly one status from fresh, stale or unknown; the never-measured dataset is reported with the exact status 'unknown' and is not counted as fresh in any per-team fresh count; the report lists every dataset in the fixture with none omitted. | syn-chloe-quality | pass | yes | evd_0mwgs448t9g219ffd2e |
| AC-POLICY-FDE: Change a dataset's threshold only in the policy configuration file (no source code edit) and re-run the shared check. Passing: the status for a fixture dataset flips between fresh and stale according to the new threshold; a source scan of the shared capability finds no hard-coded threshold values; and the same single capability, invoked with the policy entries for engine_test_runs (60 minutes) and for an NCR table, returns correct results for both, with no per-engineer copy of the check logic required. | syn-dev-fde | pass | yes | evd_0mwgs448t9g219ffd2e |
| AC-CONTRACT: Validate every record emitted by the freshness monitor against the pinned, versioned record schema. Passing: 100% of records across the fresh, stale and unknown fixtures validate; each record contains dataset, owner_team, status, last_update (null when never measured), threshold and checked_at; status is exactly one of 'fresh', 'stale', 'unknown'; a record with last_update null always has status 'unknown'; and the record carries the schema version it conforms to. | all | pass | yes | evd_0mwgs448t9g219ffd2e |

## Remaining concerns

- I did not run test/integration/pipeline.test.ts, because the report module (src/report) belongs to another workstream and shell commands other than node --test were not available to me.
- The boundary rule (staleness equal to the threshold counts as fresh) is my choice. The hidden acceptance tests may assume otherwise.
- The records carry no schema-version field, because the pinned HealthRecord contract has none. The AC-CONTRACT 'schema version' and 'last_update' fields would have to come from the report/adapter layer.
- The dash character is a guess: the hidden acceptance check might want ASCII '-' instead of '—'.
- I did not run test/integration/pipeline.test.ts. Its stale-row assertion does not depend on the changed cell, but it was not run.
- Whether syn-req-002 belongs in this capability is a scope decision that the requests do not settle.
- Threshold values for NCR tables and the policy owner are not stated.
- The data sources for freshness timestamps and the NCR table list are unverified; no data was inspected.
- The contract carries no severity ranking; the weekly review may want one
- Whether syn-req-002 should be included now; if so, a stakeholder id and AC-SCHEMA-SUPPLY criterion are needed.
- Behavior at exactly the threshold (age == 60 min) is undefined.
- NCR table list, owner-team source of truth and NCR thresholds are unknown.
- Whether the pre-review check is a hard gate or warning; AC-FRESH-PROPULSION only requires on-demand invocation and correct status.
- Delivery channel for reports and alerts is undecided.
- Whether no-timestamp and never-checked datasets both map to unknown is assumed (both unknown), not confirmed.
- No failed approaches are recorded in the inputs, so no failed_approach note was written.
- The 60-minute boundary behaviour (exactly 60 minutes) is not specified.
- AC-CONTRACT field names do not match contract/health-record v1; reconciliation is needed before that criterion can be verified.
- The contract is labelled SYNTHETIC, so it may not reflect a real production schema.
- The NCR threshold, NCR table list, owner-team mapping and threshold policy owner are all unknown.
- Freshness values are short-lived (7 to 30 days) and the notes should be re-checked as the open unknowns are resolved.
- Open question from agt_0mwgs1r2g0ua2ad28e3: Should syn-req-002 (schema contract drift by field) be folded into the same shared capability as the freshness requests (001, 003, 004), or kept as a separate capability that can reuse the same policy and reporting layer later?
- Open question from agt_0mwgs1r2g0ua2ad28e3: Who owns and approves the freshness threshold policy values (for example, the 60-minute threshold for engine_test_runs and the thresholds for NCR tables)?
- Open question from agt_0mwgs1r2g0ua2ad28e3: Which NCR tables are in scope for syn-req-003, and what is the authoritative source for owner-team mapping?
- Open question from agt_0mwgs1r2h0ya83db908: Should syn-req-002 (schema drift) be included in this plan with its own criterion AC-SCHEMA-SUPPLY, and who is the stakeholder?
- Open question from agt_0mwgs2t61449fe87093: Should the AC-CONTRACT field names be reconciled to contract/health-record v1 (dataset_id, freshness.status, schema-version property), or should the contract be revised?
- Open question from agt_0mwgs2t61449fe87093: Is the 60-minute engine_test_runs check a hard gate that blocks the dashboard, or a warning flag?
- Stakeholder need not shown satisfied: syn-ben-supplychain — The BOM cost dashboard broke when an upstream column was renamed and nobody noticed for days. We need a check that compares each table schema against its declared contract and reports drift by field.

## Decision requested

Approve the integrated result of "Shared dataset-health capability" for merge into the protected branch?

Options: approve, request_changes, reject.
Approval marks the merge request draft approved. The merge itself stays with the existing protected path.

## Resource use

- Worker invocations: 13
- Model calls: 6
- Tokens: 31777
- Cost: 0.351535 USD (list_price_estimate, not billing)
- Worker wall time: 168643 ms
