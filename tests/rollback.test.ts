import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../src/coordination/coordinator.ts';
import { LocalChiefOfStaff } from '../src/cos/port.ts';
import { Gate } from '../src/gate/gate.ts';
import { observeReviewWork, runExperiment } from '../src/evolution/loop.ts';
import { openRuntime } from '../src/runtime.ts';
import { scenarioRequests } from '../demos/lib.ts';

test('canary and rollback: a qualified release is tried on bounded missions and rolled back on a regression', async () => {
  const home = mkdtempSync(join(tmpdir(), 'swarm2-canary-'));
  const rt = openRuntime({ home });
  const gate = new Gate(rt);
  gate.init();
  const co = new Coordinator(rt);
  try {
    const cos = new LocalChiefOfStaff(rt, (m) => gate.releaseFor(m));
    cos.onPinned = (c, m) => gate.noteCanaryMission(c, m);
    const ing = cos.ingestRequests({ command: 'ingestRequests', actor: 'chief_of_staff', key: 'ing', data: { requests: scenarioRequests() } });
    assert.ok(ing.source !== 'unavailable');
    const ids = ing.clusters[0]!.request_ids;
    const submit = (key: string) => {
      const r = cos.submitMission({ command: 'submitMission', actor: 'chief_of_staff', key, data: { title: `Shared dataset-health capability (${key})`, objective: 'One policy-driven view of dataset health.', request_ids: key === 'A' ? ids : [], scenario: 'shared-capability' } });
      assert.ok(r.source !== 'unavailable');
      return r.mission;
    };

    const a = submit('A'); // submitted before any candidate exists
    assert.equal(a.release_id, 'r1');

    await observeReviewWork(rt, gate);
    const first = await runExperiment(rt, gate, 'exec-interface-compat-naive');
    const accepted = await runExperiment(rt, gate, 'exec-interface-compat', { revises_experiment: first.experiment.id });
    const r2 = accepted.receipt.release_manifest!.release_id;
    assert.throws(() => gate.retain('nope'), /not found/);

    const canary = gate.startCanary(r2, { max_missions: 2, scenario: 'shared-capability' });
    assert.throws(() => gate.retain(canary.id), /before it has been observed/);

    // Mission A needs its requests; B reuses the same intake for the canary.
    rt.store.requests.where('1=1').forEach((r) => rt.store.requests.put({ ...r, mission_id: null }));
    const b = cos.submitMission({ command: 'submitMission', actor: 'chief_of_staff', key: 'B', data: { title: 'Shared dataset-health capability (canary)', objective: 'One policy-driven view of dataset health.', request_ids: ids, scenario: 'shared-capability' } });
    assert.ok(b.source !== 'unavailable');
    assert.equal(b.mission.release_id, r2, 'a new development mission inside the canary scope gets the canary release');
    assert.equal(rt.store.missions.must(a.id).release_id, 'r1', 'a mission already running keeps its release');

    assert.equal(await co.runUntilIdle({ mission_id: b.mission.id, max_ms: 90_000 }), 'idle');
    await co.drain();
    assert.equal(rt.store.missions.must(b.mission.id).status, 'review_ready');

    const d = submit('D'); // second canary mission, still in flight when the rollback happens
    assert.equal(d.release_id, r2);
    assert.equal(submit('E').release_id, 'r1', 'the canary is bounded: once full, new missions use the active release');

    const healthy = await gate.observeCanary(canary.id);
    assert.equal(healthy.status, 'running');
    assert.ok(healthy.observations.every((o) => !o.breached));

    const deps = gate.dependents(r2);
    assert.deepEqual(deps.missions.map((m) => m.id).sort(), [b.mission.id, d.id].sort());
    assert.ok(deps.artifacts.length > 5);
    assert.ok(deps.memories.length >= 3, 'knowledge recorded under the canary release is traceable to it');

    // INJECTED REGRESSION: later traffic contains a kind of safe change no evaluation set had.
    const after = await gate.observeCanary(canary.id, { inject_regression: { class: 'unit_annotation_added', weight: 6 } });
    assert.equal(after.status, 'rolled_back');
    assert.ok(after.observations.some((o) => o.breached && o.injected && o.metric === 'accuracy_drop_vs_approval'));
    assert.equal(rt.registry.active(), 'r1');
    assert.equal(rt.registry.manifest(r2).status, 'rolled_back');

    const now = gate.dependents(r2);
    assert.ok(now.artifacts.every((x) => x.currency !== 'current'), 'artifacts produced under the rolled-back release are marked for revalidation');
    assert.ok(now.memories.every((x) => x.status === 'invalidated'), 'memories derived under it are invalidated');
    assert.equal(rt.store.missions.must(d.id).migration?.required, true, 'the in-flight mission needs a deliberate migration decision');
    assert.equal(rt.store.missions.must(b.mission.id).migration?.required, false);
    assert.equal(rt.store.missions.must(a.id).migration, null, 'missions on other releases are untouched');
    const migration = rt.store.decisions.where(`"kind" = 'migration'`);
    assert.equal(migration.length, 1);
    assert.equal(migration[0]!.mission_id, d.id);
    assert.equal(submit('F').release_id, 'r1', 'after the rollback, new work uses the restored release');
    assert.equal(gate.verifyLedger().ok, true);
    assert.ok(gate.ledger().some((l) => l.kind === 'rollback'));
  } finally {
    co.stop();
    gate.close();
    rt.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('retain: a canary that stays healthy becomes the default for future work only', async () => {
  const home = mkdtempSync(join(tmpdir(), 'swarm2-retain-'));
  const rt = openRuntime({ home });
  const gate = new Gate(rt);
  gate.init();
  try {
    const cos = new LocalChiefOfStaff(rt, (m) => gate.releaseFor(m));
    const old = cos.submitMission({ command: 'submitMission', actor: 'chief_of_staff', key: 'old', data: { title: 'An earlier mission', objective: 'x' } });
    assert.ok(old.source !== 'unavailable');
    const first = await runExperiment(rt, gate, 'exec-interface-compat-naive');
    const accepted = await runExperiment(rt, gate, 'exec-interface-compat', { revises_experiment: first.experiment.id });
    const r2 = accepted.receipt.release_manifest!.release_id;
    const canary = gate.startCanary(r2, { max_missions: 1 });
    await gate.observeCanary(canary.id);
    assert.equal(gate.retain(canary.id).status, 'retained');
    assert.equal(rt.registry.active(), r2);
    assert.equal(rt.registry.manifest('r1').status, 'retired');
    assert.equal(rt.store.missions.must(old.mission.id).release_id, 'r1', 'the earlier mission stays pinned to the release it started on');
    const next = cos.submitMission({ command: 'submitMission', actor: 'chief_of_staff', key: 'new', data: { title: 'A later mission', objective: 'y' } });
    assert.ok(next.source !== 'unavailable' && next.mission.release_id === r2);
    assert.equal(rt.registry.verify(r2).ok, true);
  } finally {
    gate.close();
    rt.close();
    rmSync(home, { recursive: true, force: true });
  }
});
