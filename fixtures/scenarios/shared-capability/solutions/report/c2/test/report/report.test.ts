import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertPayloads, renderSlaReport, type HealthRecord } from '../../src/report/report.ts';

const base = { checked_at: '2026-11-10T12:00:00Z' };
const records: HealthRecord[] = [
  { ...base, dataset_id: 'a', owner_team: 'Team B', freshness: { status: 'stale', staleness_minutes: 120, threshold_minutes: 60 }, schema: { status: 'match', drift: [] }, severity: 'watch' },
  { ...base, dataset_id: 'b', owner_team: 'Team A', freshness: { status: 'unknown', staleness_minutes: null, threshold_minutes: 60 }, schema: { status: 'unknown', drift: [] }, severity: 'watch' },
  { ...base, dataset_id: 'c', owner_team: 'Team A', freshness: { status: 'fresh', staleness_minutes: 5, threshold_minutes: 60 }, schema: { status: 'drift', drift: [{ field: 'x', change: 'missing' }] }, severity: 'watch' },
];

test('the report groups datasets by owner team and shows severity', () => {
  const text = renderSlaReport(records);
  assert.ok(text.indexOf('## Team A') < text.indexOf('## Team B'));
  assert.match(text, /\| a \| stale \| 120 \| 60 \| match \| watch \|/);
});

test('an unmeasured dataset is shown as unknown with a dash, never zero', () => {
  const text = renderSlaReport(records);
  assert.match(text, /\| b \| unknown \| — \| 60 \| unknown \| watch \|/);
});

test('alerts are raised for stale and drifting datasets only', () => {
  const alerts = alertPayloads(records);
  assert.deepEqual(alerts.map((a) => `${a.dataset_id}:${a.kind}`), ['a:stale', 'c:schema_drift']);
});
