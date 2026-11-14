# Live run: live-a

**LIVE MODEL EXECUTION.** The workers were real model processes. The requests, datasets and fixture application are SYNTHETIC.
Steps that stayed scripted from the scenario (planning.contract, planning.plan, delivery.decompose) are counted separately and were recorded as fixture attempts.

- Mission status: **blocked**; coordinator idle; 130 s elapsed.
- Model attempts: 7 (claude-haiku-5-5, claude-sonnet-5-5); scripted attempts: 3; runtime steps: 7.
- Output tokens: 28576; list-price cost estimate: 0.6185 USD (not billing).
- Rework: 4; integration failures: 0; acceptance failures: 3; tool uses refused by the worker harness: 3.
- Decisions waiting for a person: 1.

## Acceptance criteria (verified by the verification swarm on tests the workers never saw)

- AC-CONTRACT: **pass** (history: pass → pass → pass)
- AC-FRESH-PROPULSION: **pass** (history: pass → pass → pass)
- AC-POLICY-FDE: **pass** (history: pass → pass → pass)
- AC-SCHEMA-SUPPLY: **pass** (history: fail → pass → pass)
- AC-SLA-QUALITY: **fail** (history: fail → fail → fail)

## Attempts

| Task | Attempt | Provider | Model served | Status | Seconds | Output tokens | Cost estimate (USD) |
|---|---|---|---|---|---|---|---|
| discovery.analyze | 1 | claude-cli | claude-haiku-5-5 | succeeded | 22.5 | 5204 | 0.003911 |
| planning.criteria | 1 | claude-cli | claude-sonnet-5-5 | succeeded | 19.0 | 2896 | 0.058288 |
| planning.contract | 1 | fixture | — | succeeded | 0.0 | — | — |
| planning.plan | 1 | fixture | — | succeeded | 0.0 | — | — |
| delivery.decompose | 1 | fixture | — | succeeded | 0.0 | — | — |
| delivery.engine.implement | 1 | claude-cli | claude-sonnet-5-5 | succeeded | 39.2 | 7200 | 0.16647689999999998 |
| delivery.report.implement | 1 | claude-cli | claude-sonnet-5-5 | succeeded | 24.6 | 4173 | 0.1181083 |
| delivery.engine.implement | 2 | claude-cli | claude-sonnet-5-5 | succeeded | 22.3 | 3180 | 0.100869 |
| delivery.report.implement | 2 | claude-cli | claude-sonnet-5-5 | succeeded | 23.3 | 3531 | 0.0933089 |
| delivery.report.implement | 3 | claude-cli | claude-sonnet-5-5 | succeeded | 16.8 | 2392 | 0.0775531 |

## Why work was sent back

- delivery.engine.implement: independent acceptance failed: AC-SCHEMA-SUPPLY (latest verdict is fail: The expression evaluated to a falsy value: assert.ok(alert && /supplier_id/.test(alert.detail))); AC-SLA-QUALITY (latest verdict is fail: an unmeasured dataset shows unknown and a dash)
- delivery.report.implement: independent acceptance failed: AC-SCHEMA-SUPPLY (latest verdict is fail: The expression evaluated to a falsy value: assert.ok(alert && /supplier_id/.test(alert.detail))); AC-SLA-QUALITY (latest verdict is fail: an unmeasured dataset shows unknown and a dash)
- delivery.report.implement: independent acceptance failed: AC-SLA-QUALITY (latest verdict is fail: an unmeasured dataset shows unknown and a dash)
- delivery.report.implement: independent acceptance failed: AC-SLA-QUALITY (latest verdict is fail: an unmeasured dataset shows unknown and a dash)

No review packet was produced.

Files: `summary.json`, `timeline.json`, `coordinator.log`, `artifacts/` (documents the model workers wrote), `worker-reports/` (what each worker said, including its stated uncertainty), `code/` (what was integrated).
