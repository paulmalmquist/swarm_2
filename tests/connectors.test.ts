import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Coordinator } from '../src/coordination/coordinator.ts';
import { LocalFixtureRequests, LocalJsonlWarehouse, connectorStatus, exportAnalytics } from '../src/connectors/ports.ts';
import { Gate } from '../src/gate/gate.ts';
import { freshRuntime, submitScenario } from './e2e.ts';

test('an external effect with an uncertain outcome is reconciled before any retry', () => {
  const { rt, cleanup } = freshRuntime();
  try {
    const wh = new LocalJsonlWarehouse(rt);
    const rows = [{ a: 1 }, { a: 2 }];
    wh.failAfterWrite = true; // the load lands, then the connection drops
    const first = wh.load('t', rows, 'load-1');
    assert.equal(first.source, 'unavailable', 'the outcome is reported as uncertain, not as failed');
    assert.equal(rt.store.effects.first('"idempotency_key" = ?', 'load-1')!.status, 'unknown');

    wh.failAfterWrite = false;
    const retry = wh.load('t', rows, 'load-1');
    assert.ok(retry.source !== 'unavailable');
    const lines = readFileSync(join(wh.dir, 't.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'the retry found the load had landed and did not repeat it');
    assert.equal(rt.store.effects.first('"idempotency_key" = ?', 'load-1')!.attempts, 1);
    assert.equal(rt.store.events({ type: 'external_effect_reconciled' })[0]!.payload.found, 'applied');
    wh.load('t', rows, 'load-1');
    assert.equal(readFileSync(join(wh.dir, 't.jsonl'), 'utf8').trim().split('\n').length, 2, 'a confirmed effect is never repeated');
  } finally {
    cleanup();
  }
});

test('connectors report honestly what is connected, and history exports for analysis', async () => {
  const { rt, cleanup } = freshRuntime();
  const gate = new Gate(rt);
  const co = new Coordinator(rt);
  try {
    const status = connectorStatus();
    assert.ok(status.every((s) => !s.available), 'nothing real is connected in the build environment');
    assert.ok(status.every((s) => s.requirement.length > 40), 'each system states its integration requirement');
    const src = new LocalFixtureRequests().fetch();
    assert.ok(src.source === 'fixture' && src.requests.every((r) => r.id.startsWith('syn-')));

    const { mission_id } = submitScenario(rt, 'export');
    await co.runUntilIdle({ mission_id, max_ms: 90_000 });
    await co.drain();
    const wh = new LocalJsonlWarehouse(rt);
    const out = exportAnalytics(rt, gate, wh);
    assert.equal(out.tables.missions, 1);
    assert.ok(out.tables.tasks! >= 18 && out.tables.attempts! >= 10 && out.tables.verifications! >= 10);
    assert.ok(existsSync(out.schema_path));
    const outcome = JSON.parse(readFileSync(join(wh.dir, 'outcomes.jsonl'), 'utf8').trim().split('\n')[0]!) as { verified_success: boolean; escaped_defects: number | null };
    assert.equal(outcome.verified_success, true);
    assert.equal(outcome.escaped_defects, null, 'unmeasured values are exported as null');
    const again = exportAnalytics(rt, gate, wh);
    assert.deepEqual(again.tables, out.tables);
    assert.equal(readFileSync(join(wh.dir, 'missions.jsonl'), 'utf8').trim().split('\n').length, 1, 'repeating the export does not duplicate rows');
  } finally {
    co.stop();
    gate.close();
    cleanup();
  }
});
