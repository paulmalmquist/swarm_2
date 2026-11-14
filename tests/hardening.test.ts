import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Coordinator } from '../src/coordination/coordinator.ts';
import { LocalChiefOfStaff } from '../src/cos/port.ts';
import { performEffect, LocalJsonlWarehouse } from '../src/connectors/ports.ts';
import { Gate } from '../src/gate/gate.ts';
import { runExperiment, CANDIDATE_LIBRARY } from '../src/evolution/loop.ts';
import { ingestKnowledge, retrieve } from '../src/memory/memory.ts';
import { applyFileChanges } from '../src/workspace/patches.ts';
import { testRunPassed, type RunResult } from '../src/workspace/workspaces.ts';
import { freshRuntime, submitScenario, scenarioRequests } from './e2e.ts';
import { serve } from '../src/api/server.ts';
import { waitFor } from '../demos/lib.ts';
import { pidAlive } from '../src/lib/util.ts';

test('test execution cannot read host state, inherit secrets, write source, or reach the host network', async () => {
  const { rt, home, cleanup } = freshRuntime();
  const workspace = join(home, 'sandbox-work');
  mkdirSync(workspace);
  const secret = join(home, 'operator-secret');
  writeFileSync(secret, 'sentinel');
  process.env.SWARM2_TEST_SECRET = 'not-for-workers';
  const server = createServer((socket) => socket.end('host'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const source = `import assert from 'node:assert/strict'; import {readFileSync,writeFileSync} from 'node:fs'; import {connect} from 'node:net';
      assert.equal(process.env.SWARM2_TEST_SECRET, undefined);
      assert.throws(() => readFileSync(${JSON.stringify(secret)}));
      assert.throws(() => writeFileSync(${JSON.stringify(join(workspace, 'modified'))}, 'x'));
      const reached = await new Promise((resolve) => { const s=connect({host:'127.0.0.1',port:${port}}); s.on('connect',()=>{s.destroy();resolve(true)}); s.on('error',()=>resolve(false)); s.setTimeout(500,()=>{s.destroy();resolve(false)}); });
      assert.equal(reached, false);
      console.log('isolated');`;
    const run = await rt.workspaces.run(workspace, ['node', '--input-type=module', '-e', source]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /isolated/);
    assert.equal(existsSync(join(workspace, 'modified')), false);
    const flood = await rt.workspaces.run(workspace, ['node', '-e', "const fs=require('fs'), s='x'.repeat(65536); while(true) fs.writeSync(1,s)"], 5000);
    assert.equal(flood.output_limited, true);
    assert.ok(flood.stdout.length <= 1024 * 1024);
    const hang = await rt.workspaces.run(workspace, ['node', '-e', "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'inherit'});setInterval(()=>{},100)"], 200);
    assert.equal(hang.timed_out, true);
    assert.ok(hang.ms < 2000, 'descendants must not keep the output pipes alive');
  } finally { delete process.env.SWARM2_TEST_SECRET; await new Promise<void>((resolve) => server.close(() => resolve())); cleanup(); }
});

test('passing subsets, skip/TODO, missing plans, failure exits and truncated output prove nothing', () => {
  const good: RunResult = { code: 0, stdout: 'TAP version 13\nok 1 - AC-A: good\n1..1\n', stderr: '', ms: 1, timed_out: false };
  assert.equal(testRunPassed(good), true);
  for (const bad of [
    { ...good, code: 1 }, { ...good, timed_out: true }, { ...good, output_limited: true },
    { ...good, stdout: good.stdout.replace('1..1', '1..2') },
    { ...good, stdout: good.stdout.replace('1..1', '') },
    { ...good, stdout: good.stdout.replace('good', 'good # SKIP') },
    { ...good, stdout: good.stdout.replace('good', 'good # TODO later') },
    { ...good, stdout: good.stdout.replace('1..1', 'not ok 2 - unexpected failure\n1..2') },
  ]) assert.equal(testRunPassed(bad), false, bad.stdout);
});

test('file proposals reject traversal, symlinks and out-of-scope paths before applying edits', () => {
  const { rt, home, cleanup } = freshRuntime();
  const dir = join(home, 'work'); mkdirSync(dir);
  try {
    applyFileChanges(dir, [{ path: 'src/a.ts', content: 'original' }], ['src/**']);
    symlinkSync(home, join(dir, 'src', 'linked'));
    for (const path of ['../outside', '.git/config', 'src/linked/escape', 'other.ts']) {
      assert.throws(() => applyFileChanges(dir, [{ path: 'src/a.ts', content: 'changed' }, { path, content: 'bad' }], ['src/**']));
      assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), 'original');
    }
  } finally { rt.workspaces.stop(); cleanup(); }
});

test('an unprefixed acceptance failure blocks a mission even when every named criterion passes', async () => {
  const { rt, cleanup } = freshRuntime(); const co = new Coordinator(rt);
  const run = rt.workspaces.run.bind(rt.workspaces);
  rt.workspaces.run = async (...args) => {
    const result = await run(...args);
    if (args[1].includes('acceptance/**/*.test.ts')) {
      result.stdout = result.stdout.replace(/^1\.\.(\d+)$/m, (_, n: string) => `not ok ${Number(n) + 1} - unrelated application crash\n1..${Number(n) + 1}`);
      result.code = 1;
    }
    return result;
  };
  try {
    const { mission_id } = submitScenario(rt);
    await co.runUntilIdle({ mission_id, max_ms: 60_000 }); await co.drain();
    assert.equal(rt.store.missions.must(mission_id).status, 'blocked');
    assert.equal(rt.store.outcomes.first('"mission_id" = ?', mission_id)?.verified_success ?? false, false);
  } finally { co.stop(); await co.drain(); cleanup(); }
});

test('the gate rejects routing changes smuggled alongside a tested validator', async () => {
  const { rt, home, cleanup } = freshRuntime(); const gate = new Gate(rt); gate.init();
  try {
    const spec = join(home, 'spec'); cpSync(join(CANDIDATE_LIBRARY, 'exec-interface-compat'), spec, { recursive: true });
    const p = join(spec, 'candidate.json'), json = JSON.parse(readFileSync(p, 'utf8'));
    json.definition_patch = { routing: { default: { model: 'not-a-real-model', effort: null }, by_role: {}, by_archetype: {} } };
    writeFileSync(p, JSON.stringify(json));
    await assert.rejects(runExperiment(rt, gate, 'injected-routing', { spec_dir: spec }), /outside the evaluated skill/);
    assert.equal(rt.registry.active(), 'r1');
    assert.equal(gate.receipts.count(), 0);
  } finally { gate.close(); cleanup(); }
});

test('review decisions and their effects roll back together; success requires human acceptance', async () => {
  const { rt, cleanup } = freshRuntime(); const co = new Coordinator(rt);
  try {
    const { cos, mission_id } = submitScenario(rt);
    await co.runUntilIdle({ mission_id, max_ms: 60_000 }); await co.drain();
    const review = rt.store.getMeta<{ decision_id: string; draft_id: string }>(`mission:${mission_id}:review`)!;
    const outcome = () => rt.store.outcomes.first('"mission_id" = ?', mission_id)!;
    assert.equal(outcome().technical_success, true); assert.equal(outcome().verified_success, false);
    const cmd = { command: 'resolveDecision', actor: 'paul', key: 'approve', data: { decision_id: review.decision_id, chosen: 'approve', rationale: 'synthetic test approval' } };
    const original = rt.comms.reviewDraft.bind(rt.comms);
    rt.comms.reviewDraft = () => { throw new Error('injected failure applying approval'); };
    assert.throws(() => cos.resolveDecision(cmd), /injected failure/);
    assert.equal(rt.store.decisions.must(review.decision_id).status, 'open');
    assert.equal(rt.store.missions.must(mission_id).status, 'review_ready');
    rt.comms.reviewDraft = original;
    cos.resolveDecision(cmd); cos.resolveDecision(cmd);
    assert.equal(rt.store.missions.must(mission_id).status, 'completed');
    assert.equal(outcome().verified_success, true);
    assert.equal(outcome().human_acceptance, 'accepted');
    assert.equal(rt.store.outcomes.where('"mission_id" = ?', mission_id).length, 1);
    rt.kernel.setMissionStatus(mission_id, 'active', 'test', { reason: 'new upstream work' });
    assert.equal(outcome().verified_success, false, 'reopening work revokes an earlier success');
  } finally { co.stop(); await co.drain(); cleanup(); }
});

test('memory cannot self-certify, cite missing sources, or cross into real missions', async () => {
  const { rt, cleanup } = freshRuntime(); const co = new Coordinator(rt);
  try {
    const { mission_id, cos } = submitScenario(rt); await co.tick(mission_id);
    const task = rt.store.tasks.where('"mission_id" = ?', mission_id).find((t) => t.executor === 'worker')!;
    const note = { kind: 'fact', statement: 'Unverified assertion', scope: ['archetype:delivery'], source_refs: ['missing'], certainty: 'verified' };
    assert.throws(() => ingestKnowledge(rt, task, { notes: [note] }), /Unknown or stale source/);
    const [mem] = ingestKnowledge(rt, task, { notes: [{ ...note, source_refs: ['intake/requests'] }] });
    assert.equal(mem!.certainty, 'suspected');
    assert.throws(() => ingestKnowledge(rt, task, { notes: [{ ...note, kind: 'correction', source_refs: ['intake/requests'] }] }), /Invalid agent knowledge/);
    const m = cos.submitMission({ command: 'submitMission', actor: 'paul', key: 'real', data: { title: 'real', objective: 'real', data_class: 'real' } });
    assert.ok(m.source !== 'unavailable');
    assert.equal(retrieve(rt, { mission_id: m.mission.id, scopes: note.scope, text: note.statement, limit: 10, include_failed_approaches: true }).length, 0);
  } finally { co.stop(); await co.drain(); cleanup(); }
});

test('source revisions fence old work, preserve history, and ignore stale redelivery', () => {
  const { rt, cleanup } = freshRuntime();
  try {
    const { cos, mission_id } = submitScenario(rt);
    const request = scenarioRequests()[0]!;
    assert.throws(() => cos.ingestRequests({ command: 'ingestRequests', actor: 'paul', key: 'bad', data: { requests: [{ ...request, text: 'changed without revision' }] } }), /newer source_revision/);
    cos.ingestRequests({ command: 'ingestRequests', actor: 'paul', key: 'revision', data: { requests: [{ ...request, text: 'revised requirement', source_revision: 2 }] } });
    assert.equal(rt.store.missions.must(mission_id).status, 'cancelled');
    assert.equal(rt.store.requests.must(request.id).mission_id, null);
    assert.ok(rt.store.getMeta(`request:${request.id}:revision:1`));
    cos.ingestRequests({ command: 'ingestRequests', actor: 'paul', key: 'old-delivery', data: { requests: [request] } });
    assert.equal(rt.store.requests.must(request.id).text, 'revised requirement');
  } finally { cleanup(); }
});

test('effects bind adapter, action and payload to their idempotency key', () => {
  const { rt, cleanup } = freshRuntime(); let calls = 0;
  const effect = { adapter: 'one', action: 'create', idempotency_key: 'same', request: { value: 1 }, run: () => ({ n: ++calls }), reconcile: () => 'not_applied' as const };
  try {
    performEffect(rt, effect); performEffect(rt, effect); assert.equal(calls, 1);
    assert.throws(() => performEffect(rt, { ...effect, request: { value: 2 } }), /different request/);
    performEffect(rt, { ...effect, adapter: 'two' }); performEffect(rt, { ...effect, action: 'update' });
    assert.equal(calls, 3);
    const warehouse = new LocalJsonlWarehouse(rt);
    warehouse.load('first', [{ value: 1 }], 'same-load');
    warehouse.load('second', [{ value: 2 }], 'same-load');
    assert.match(readFileSync(join(warehouse.dir, 'second.jsonl'), 'utf8'), /"value":2/);
    assert.throws(() => warehouse.load('second', [{ value: 3 }], 'same-load'), /different request/);
  } finally { cleanup(); }
});

test('rejection and source revision cannot leave a successful outcome or approve a cancelled review', async () => {
  for (const mode of ['reject', 'revise'] as const) {
    const { rt, cleanup } = freshRuntime(); const co = new Coordinator(rt);
    try {
      const { cos, mission_id } = submitScenario(rt);
      await co.runUntilIdle({ mission_id, max_ms: 60_000 }); await co.drain();
      const review = rt.store.getMeta<{ decision_id: string }>(`mission:${mission_id}:review`)!;
      const cmd = { command: 'resolveDecision', actor: 'paul', key: mode, data: { decision_id: review.decision_id, chosen: 'reject', rationale: 'synthetic regression test' } };
      if (mode === 'reject') {
        cos.resolveDecision(cmd);
        assert.equal(rt.store.outcomes.first('"mission_id" = ?', mission_id)!.human_acceptance, 'rejected');
      } else {
        cos.ingestRequests({ command: 'ingestRequests', actor: 'paul', key: 'revised-source', data: { requests: [{ ...scenarioRequests()[0]!, text: 'new requirement', source_revision: 2 }] } });
        assert.throws(() => cos.resolveDecision({ ...cmd, data: { ...cmd.data, chosen: 'approve' } }), /cancelled mission/);
      }
      assert.equal(rt.store.missions.must(mission_id).status, 'cancelled');
      assert.equal(rt.store.outcomes.first('"mission_id" = ?', mission_id)!.verified_success, false);
    } finally { co.stop(); await co.drain(); cleanup(); }
  }
});

test('invalid knowledge after verification is retried within limits instead of stranding the task', async () => {
  const { rt, cleanup } = freshRuntime(); const co = new Coordinator(rt);
  co.onKnowledge = () => { throw new Error('unknown knowledge source'); };
  try {
    const { mission_id } = submitScenario(rt);
    await co.runUntilIdle({ mission_id, max_ms: 60_000 }); await co.drain();
    assert.equal(rt.store.missions.must(mission_id).status, 'blocked');
    assert.equal(rt.store.tasks.where('"mission_id" = ?', mission_id).filter((t) => t.status === 'verifying').length, 0);
    assert.equal(rt.store.memories.count(), 0);
  } finally { co.stop(); await co.drain(); cleanup(); }
});

test('STOP in server mode kills a live worker and fences its lease before closing the database', async () => {
  const { rt, home, cleanup } = freshRuntime();
  const { mission_id } = submitScenario(rt);
  rt.store.setMeta(`faults:${mission_id}`, [{ task_key: 'discovery.analyze', attempt: 1, fault: 'slow:8000' }]);
  const server = await serve({ home, port: 0, run: true, quiet: true });
  try {
    const attempt = await waitFor(() => rt.store.attempts.where('"mission_id" = ?', mission_id).find((a) => a.status === 'running' && a.pid), 10_000, 'worker');
    writeFileSync(join(home, 'STOP'), 'stop');
    await waitFor(() => !pidAlive(attempt.pid!) && rt.store.attempts.must(attempt.id).status !== 'running', 5000, 'stopped worker');
    assert.equal(rt.kernel.activeCalls(), 0);
  } finally { await server.close(); cleanup(); }
});
