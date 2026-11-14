// The integration boundary: the engine's output must satisfy the pinned contract, and the report
// must consume exactly that. Neither workstream can pass this alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { validate } from '../support/validate.ts';

const root = new URL('../../', import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));

async function pipeline() {
  const { evaluateHealth } = await import('../../src/engine/evaluate.ts');
  const report = await import('../../src/report/report.ts');
  const data = read('data/datasets.json');
  const records = evaluateHealth(data.datasets, read('data/policies.json'), data.as_of);
  return { records, report, data };
}

if (existsSync(new URL('contracts/health-record.schema.json', root))) test('engine: every record conforms to the pinned contract', async () => {
  // A mission run without an interface agreement pins no contract, so there is nothing to conform
  // to at this boundary. The acceptance suite still checks the record afterwards.
  const { records } = await pipeline();
  const contract = read('contracts/health-record.schema.json');
  assert.equal(records.length, 5);
  for (const r of records) assert.deepEqual(validate(r, contract), [], `record ${r.dataset_id}`);
});

test('report: renders the staleness the engine measured for every dataset', async () => {
  const { records, report, data } = await pipeline();
  const text = report.renderSlaReport(records);
  for (const d of data.datasets) assert.ok(text.includes(d.dataset_id), `${d.dataset_id} is missing from the report`);
  assert.match(text, /syn-engine_test_runs \| stale \| 4380 \|/, 'the stale dataset shows the measured staleness');
});

test('pipeline: stale and drifting datasets raise alerts', async () => {
  const { records, report } = await pipeline();
  const alerts = report.alertPayloads(records);
  assert.ok(alerts.some((a: { dataset_id: string; kind: string }) => a.dataset_id === 'syn-engine_test_runs' && a.kind === 'stale'));
  assert.ok(alerts.some((a: { dataset_id: string; kind: string }) => a.dataset_id === 'syn-bom_cost_rollup' && a.kind === 'schema_drift'));
});
