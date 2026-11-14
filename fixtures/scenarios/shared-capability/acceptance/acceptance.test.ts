// PROTECTED ACCEPTANCE SUITE (synthetic). Owned by the verification swarm.
// It is copied into a clean checkout of the integrated result only at verification time;
// delivery workers never see it. Each test name starts with the acceptance criterion it decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate } from './validate.ts';

const root = new URL('../', import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));
const data = read('data/datasets.json');
const policies = read('data/policies.json');
const contract = read('contracts/health-record.schema.json');

async function load() {
  const { evaluateHealth } = await import('../src/engine/evaluate.ts');
  const report = await import('../src/report/report.ts');
  return { evaluateHealth, report };
}

test('AC-FRESH-PROPULSION: a dataset older than its own threshold is stale and alerted', async () => {
  const { evaluateHealth, report } = await load();
  const records = evaluateHealth(data.datasets, policies, data.as_of);
  const r = records.find((x: { dataset_id: string }) => x.dataset_id === 'syn-engine_test_runs');
  assert.equal(r.freshness.status, 'stale');
  assert.equal(r.freshness.threshold_minutes, 60);
  assert.equal(r.freshness.staleness_minutes, 4380);
  const alerts = report.alertPayloads(records);
  assert.ok(alerts.some((a: { dataset_id: string; kind: string }) => a.dataset_id === 'syn-engine_test_runs' && a.kind === 'stale'));
});

test('AC-SCHEMA-SUPPLY: an upstream column rename is reported as drift naming both fields', async () => {
  const { evaluateHealth, report } = await load();
  const records = evaluateHealth(data.datasets, policies, data.as_of);
  const r = records.find((x: { dataset_id: string }) => x.dataset_id === 'syn-bom_cost_rollup');
  assert.equal(r.schema.status, 'drift');
  assert.deepEqual(r.schema.drift.map((d: { field: string; change: string }) => `${d.field}:${d.change}`).sort(), ['supplier_code:unexpected', 'supplier_id:missing']);
  const alert = report.alertPayloads(records).find((a: { dataset_id: string; kind: string }) => a.dataset_id === 'syn-bom_cost_rollup' && a.kind === 'schema_drift');
  assert.ok(alert && /supplier_id/.test(alert.detail));
});

test('AC-SLA-QUALITY: the SLA report groups by owner team and shows unmeasured as unknown, never zero', async () => {
  const { evaluateHealth, report } = await load();
  const text: string = report.renderSlaReport(evaluateHealth(data.datasets, policies, data.as_of));
  const section = text.slice(text.indexOf('## Manufacturing Quality'));
  assert.ok(section.includes('syn-ncr_events') && section.includes('syn-ncr_dispositions'), 'both NCR tables are under their owner team');
  const row = text.split('\n').find((l) => l.includes('syn-ncr_dispositions')) ?? '';
  assert.match(row, /\| unknown \| — \|/, 'an unmeasured dataset shows unknown and a dash');
  assert.doesNotMatch(row, /\| (fresh|0) \|/, 'an unmeasured dataset never looks fresh or zero');
});

test('AC-POLICY-FDE: thresholds come from policy configuration, not code', async () => {
  const { evaluateHealth } = await load();
  const tightened = structuredClone(policies);
  tightened.default.freshness_threshold_minutes = 1;
  const before = evaluateHealth(data.datasets, policies, data.as_of).find((x: { dataset_id: string }) => x.dataset_id === 'syn-fde_site_metrics');
  const after = evaluateHealth(data.datasets, tightened, data.as_of).find((x: { dataset_id: string }) => x.dataset_id === 'syn-fde_site_metrics');
  assert.equal(before.freshness.status, 'fresh');
  assert.equal(before.freshness.threshold_minutes, 1440, 'a dataset without its own threshold uses the policy default');
  assert.equal(after.freshness.status, 'stale', 'changing only the policy changes the result');
});

test('AC-CONTRACT: every record conforms to the pinned HealthRecord contract', async () => {
  const { evaluateHealth } = await load();
  const records = evaluateHealth(data.datasets, policies, data.as_of);
  assert.equal(records.length, data.datasets.length);
  for (const r of records) assert.deepEqual(validate(r, contract), [], `record ${r.dataset_id} violates contract version ${contract.version}`);
});
