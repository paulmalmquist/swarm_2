# Live run: live-b

**LIVE MODEL EXECUTION.** The workers were real model processes. The requests, datasets and fixture application are SYNTHETIC.
Steps that stayed scripted from the scenario (planning.contract, planning.plan, delivery.decompose) are counted separately and were recorded as fixture attempts.

- Mission status: **blocked**; coordinator idle; 193 s elapsed.
- Model attempts: 9 (claude-haiku-5-5, claude-sonnet-5-5); scripted attempts: 3; runtime steps: 6.
- Output tokens: 23679; list-price cost estimate: 0.4105 USD (not billing).
- Rework: 2; integration failures: 0; acceptance failures: 3; tool uses refused by the worker harness: 1.
- Decisions waiting for a person: 1.

## Acceptance criteria (verified by the verification swarm on tests the workers never saw)

- AC-CONTRACT: **pass** (history: pass → pass → pass)
- AC-FRESH-PROPULSION: **pass** (history: pass → pass → pass)
- AC-POLICY-FDE: **pass** (history: pass → pass → pass)
- AC-SLA-QUALITY: **pass** (history: fail → fail → pass)

## Attempts

| Task | Attempt | Provider | Model served | Status | Seconds | Output tokens | Cost estimate (USD) |
|---|---|---|---|---|---|---|---|
| discovery.analyze | 1 | claude-cli | claude-haiku-5-5 | succeeded | 24.3 | 5481 | 0.00336485 |
| planning.criteria | 1 | claude-cli | claude-sonnet-5-5 | succeeded | 23.0 | 3389 | 0.0511025 |
| planning.contract | 1 | fixture | — | succeeded | 0.0 | — | — |
| planning.plan | 1 | fixture | — | succeeded | 0.0 | — | — |
| delivery.decompose | 1 | fixture | — | succeeded | 0.0 | — | — |
| delivery.engine.implement | 1 | claude-cli | claude-sonnet-5-5 | succeeded | 36.8 | 6785 | 0.1302585 |
| delivery.report.implement | 1 | claude-cli | claude-sonnet-5-5 | succeeded | 22.6 | 3758 | 0.0870374 |
| delivery.report.implement | 2 | claude-cli | claude-sonnet-5-5 | succeeded | 12.3 | 1543 | 0.0604614 |
| delivery.report.implement | 3 | claude-cli | claude-sonnet-5-5 | succeeded | 21.9 | 2723 | 0.07831350000000001 |
| reliability.knowledge | 1 | claude-cli | — | failed (timeout) | — | — | — |
| reliability.knowledge | 2 | claude-cli | — | failed (timeout) | — | — | — |
| reliability.knowledge | 3 | claude-cli | — | failed (timeout) | — | — | — |

## Why work was sent back

- delivery.report.implement: independent acceptance failed: AC-SLA-QUALITY (latest verdict is fail: this did not hold: "an unmeasured dataset shows unknown and a dash" — it got: syn-ncr_dispositions | unknown | n/a | 720 | unknown)
- delivery.report.implement: independent acceptance failed: AC-SLA-QUALITY (latest verdict is fail: this did not hold: "an unmeasured dataset shows unknown and a dash" — it got: syn-ncr_dispositions | unknown | - | 720 | unknown)

No review packet was produced.

Files: `summary.json`, `timeline.json`, `coordinator.log`, `artifacts/` (documents the model workers wrote), `worker-reports/` (what each worker said, including its stated uncertainty), `code/` (what was integrated).
