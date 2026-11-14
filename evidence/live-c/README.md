# Live run: live-c

**LIVE MODEL EXECUTION.** The workers were real model processes. The requests, datasets and fixture application are SYNTHETIC.
Steps that stayed scripted from the scenario (planning.contract, planning.plan, delivery.decompose) are counted separately and were recorded as fixture attempts.

- Mission status: **review_ready** — a review packet is waiting for a decision; coordinator idle; 150 s elapsed.
- Model attempts: 6 (claude-haiku-5-5, claude-sonnet-5-5); scripted attempts: 3; runtime steps: 5.
- Output tokens: 31741; list-price cost estimate: 0.3515 USD (not billing).
- Rework: 1; integration failures: 0; acceptance failures: 1; tool uses refused by the worker harness: 2.
- Decisions waiting for a person: 2.

## Acceptance criteria (verified by the verification swarm on tests the workers never saw)

- AC-CONTRACT: **pass** (history: pass → pass)
- AC-FRESH-PROPULSION: **pass** (history: pass → pass)
- AC-POLICY-FDE: **pass** (history: pass → pass)
- AC-SLA-QUALITY: **pass** (history: fail → pass)

## Attempts

| Task | Attempt | Provider | Model served | Status | Seconds | Output tokens | Cost estimate (USD) |
|---|---|---|---|---|---|---|---|
| discovery.analyze | 1 | claude-cli | claude-haiku-5-5 | succeeded | 25.4 | 5763 | 0.00350745 |
| planning.criteria | 1 | claude-cli | claude-sonnet-5-5 | succeeded | 22.1 | 3399 | 0.0504625 |
| planning.contract | 1 | fixture | — | succeeded | 0.0 | — | — |
| planning.plan | 1 | fixture | — | succeeded | 0.0 | — | — |
| delivery.decompose | 1 | fixture | — | succeeded | 0.0 | — | — |
| delivery.engine.implement | 1 | claude-cli | claude-sonnet-5-5 | succeeded | 39.4 | 6875 | 0.1331935 |
| delivery.report.implement | 1 | claude-cli | claude-sonnet-5-5 | succeeded | 25.1 | 4277 | 0.0936715 |
| delivery.report.implement | 2 | claude-cli | claude-sonnet-5-5 | succeeded | 16.9 | 1792 | 0.06467719999999999 |
| reliability.knowledge | 1 | claude-cli | claude-haiku-5-5 | succeeded | 37.8 | 9635 | 0.00602217 |

## Why work was sent back

- delivery.report.implement: independent acceptance failed: AC-SLA-QUALITY (latest verdict is fail: this did not hold: "an unmeasured dataset shows unknown and a dash" — it got: syn-ncr_dispositions | unknown | n/a | 720 | unknown)

Decision requested of the chief of staff: Approve the integrated result of "Shared dataset-health capability" for merge into the protected branch?

Files: `summary.json`, `timeline.json`, `coordinator.log`, `artifacts/` (documents the model workers wrote), `worker-reports/` (what each worker said, including its stated uncertainty), `code/` (what was integrated).
