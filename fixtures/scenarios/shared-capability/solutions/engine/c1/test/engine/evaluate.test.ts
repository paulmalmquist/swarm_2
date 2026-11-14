import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealth } from '../../src/engine/evaluate.ts';

const policies = { default: { freshness_threshold_minutes: 1440 }, datasets: { a: { freshness_threshold_minutes: 60, declared_fields: { id: 'string', n: 'number' } } } };
const asOf = '2026-11-10T12:00:00Z';

test('a dataset older than its threshold is stale', () => {
  const [r] = evaluateHealth([{ dataset_id: 'a', owner_team: 't', last_loaded_at: '2026-11-10T10:00:00Z', observed_fields: { id: 'string', n: 'number' } }], policies, asOf);
  assert.equal(r!.freshness.status, 'stale');
  assert.equal(r!.freshness.staleness_minutes, 120);
  assert.equal(r!.schema.status, 'match');
});

test('a dataset never loaded is unknown, not fresh', () => {
  const [r] = evaluateHealth([{ dataset_id: 'a', owner_team: 't', last_loaded_at: null, observed_fields: null }], policies, asOf);
  assert.equal(r!.freshness.status, 'unknown');
  assert.equal(r!.freshness.staleness_minutes, null);
  assert.equal(r!.schema.status, 'unknown');
});

test('missing, unexpected and retyped fields are reported as drift', () => {
  const [r] = evaluateHealth([{ dataset_id: 'a', owner_team: 't', last_loaded_at: asOf, observed_fields: { n: 'string', extra: 'string' } }], policies, asOf);
  assert.deepEqual(r!.schema.drift, [
    { field: 'id', change: 'missing' },
    { field: 'n', change: 'type_changed' },
    { field: 'extra', change: 'unexpected' },
  ]);
});

test('a dataset without its own policy uses the default threshold', () => {
  const [r] = evaluateHealth([{ dataset_id: 'other', owner_team: 't', last_loaded_at: '2026-11-10T00:00:00Z', observed_fields: null }], policies, asOf);
  assert.equal(r!.freshness.threshold_minutes, 1440);
  assert.equal(r!.freshness.status, 'fresh');
});
