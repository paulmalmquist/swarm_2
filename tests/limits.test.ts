import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/config.ts';
import { Coordinator } from '../src/coordination/coordinator.ts';
import { runEpisode } from '../src/evolution/episodes.ts';
import { runExperiment } from '../src/evolution/loop.ts';
import { Gate } from '../src/gate/gate.ts';
import { pidAlive, sleep } from '../src/lib/util.ts';
import { openRuntime } from '../src/runtime.ts';
import { freshRuntime, submitScenario } from './e2e.ts';

async function tickUntil(co: Coordinator, done: () => boolean, max_ms = 15_000): Promise<void> {
  const deadline = Date.now() + max_ms;
  while (!done() && Date.now() < deadline) {
    await co.tick();
    await sleep(25);
  }
  assert.ok(done(), 'the expected state was reached in time');
}

test('a mission past its wall-clock ceiling stops for a person, who alone can extend it', async () => {
  const { rt, cleanup } = freshRuntime({ max_wall_ms: 250 });
  const co = new Coordinator(rt);
  try {
    const { cos, mission_id } = submitScenario(rt, 'wall');
    const status = (): string => rt.store.missions.must(mission_id).status;
    await tickUntil(co, () => status() === 'blocked');

    const open = rt.store.decisions.where(`"mission_id" = ? AND "kind" = 'limit_reached'`, mission_id);
    assert.equal(open.length, 1);
    assert.equal(open[0]!.requires_human, true);
    assert.equal(open[0]!.owner_kind, 'chief_of_staff');
    const att = cos.attention();
    assert.ok(att.source !== 'unavailable' && att.items.some((i) => i.kind === 'decision' && i.id === open[0]!.id), 'the decision reaches the chief of staff');

    // Nothing keeps running on a stopped mission, and waiting for a person does not use up the limit.
    await sleep(200);
    const pids = rt.store.attempts.where('"mission_id" = ?', mission_id).map((a) => a.pid).filter((p): p is number => typeof p === 'number');
    assert.ok(pids.length > 0 && pids.every((p) => !pidAlive(p)), 'its workers were stopped');
    const frozen = rt.kernel.runningMs(mission_id);
    await sleep(120);
    assert.equal(rt.kernel.runningMs(mission_id), frozen, 'time spent waiting for a person is not counted');
    await co.tick();
    assert.equal(rt.store.decisions.count(`"mission_id" = ? AND "kind" = 'limit_reached'`, mission_id), 1, 'the question is asked once');

    const ext = cos.resolveDecision({ command: 'resolveDecision', actor: 'paul', key: 'wall-extend', data: { decision_id: open[0]!.id, chosen: 'extend', rationale: 'one more period' } });
    assert.ok(ext.source !== 'unavailable' && /extended/.test(ext.effect));
    assert.equal(status(), 'active');
    assert.equal(rt.kernel.wallLimitMs(mission_id), 500);
    assert.equal(rt.store.events({ mission_id, type: 'limit_extended' }).length, 1);

    // The extension is itself a ceiling.
    await tickUntil(co, () => status() === 'blocked');
    const second = rt.store.decisions.where(`"mission_id" = ? AND "kind" = 'limit_reached' AND "status" = 'open'`, mission_id);
    assert.equal(second.length, 1);
    assert.notEqual(second[0]!.id, open[0]!.id);
    const cancel = cos.resolveDecision({ command: 'resolveDecision', actor: 'paul', key: 'wall-cancel', data: { decision_id: second[0]!.id, chosen: 'cancel', rationale: 'not worth more time' } });
    assert.ok(cancel.source !== 'unavailable' && /cancelled/.test(cancel.effect));
    assert.equal(status(), 'cancelled');
  } finally {
    co.stop();
    await co.drain();
    cleanup();
  }
});

test('improvement work draws on a bounded exploration allocation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'swarm2-explore-'));
  const rt = openRuntime({ home });
  const gate = new Gate(rt);
  gate.init();
  try {
    const before = gate.exploration();
    assert.ok(before.budget > 0 && before.spent === 0 && before.remaining === before.budget);
    const r = await runExperiment(rt, gate, 'exec-fast-review');
    const after = gate.exploration();
    assert.equal(after.spent, r.receipt.resource_use.experiment_units, 'every experiment is charged to the allocation, accepted or not');
    assert.ok(after.spent > 0);

    // TEST FIXTURE: a copy of that receipt sized to use up the rest of the allocation.
    gate.receipts.put({ ...r.receipt, id: 'rcp_test_fixture_allocation_spent', receipt_id: 'rcp_test_fixture_allocation_spent', resource_use: { ...r.receipt.resource_use, experiment_units: after.remaining } });
    assert.equal(gate.exploration().remaining, 0);
    await assert.rejects(() => runExperiment(rt, gate, 'exec-interface-compat'), /exploration allocation/, 'no further experiment opens once the allocation is spent');
  } finally {
    gate.close();
    rt.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('coordination episodes: independent verification catches an injected defect that self-verification lets through', async () => {
  // A development seed (not one of the protected held-out sets), chosen so that a defect is injected.
  const seeds = Array.from({ length: 40 }, (_, i) => `dev-episode-${i}`);
  const incumbentDir = join(REPO_ROOT, 'definitions', 'coordination', 'v1');
  const home = mkdtempSync(join(tmpdir(), 'swarm2-episode-test-'));
  try {
    // Build the candidate policy the same way the gate would: the incumbent with one switch changed.
    const { cpSync, readFileSync, writeFileSync } = await import('node:fs');
    const candidateDir = join(home, 'coordination');
    cpSync(incumbentDir, candidateDir, { recursive: true });
    const p = join(candidateDir, 'coordination.json');
    const def = JSON.parse(readFileSync(p, 'utf8')) as { reviewer_assignment: { independent_verification: boolean } };
    def.reviewer_assignment.independent_verification = false;
    writeFileSync(p, JSON.stringify(def, null, 2));

    let seed: string | null = null;
    let withVerification = null;
    for (const s of seeds) {
      const e = await runEpisode(incumbentDir, s, { defect_rate: 0.5 });
      if (e.injected) {
        seed = s;
        withVerification = e;
        break;
      }
      assert.equal(e.truly_correct, true, 'an episode with no injected defect is correct');
    }
    assert.ok(seed && withVerification, 'a seed with an injected defect exists among the development seeds');
    assert.equal(withVerification.completed, true);
    assert.equal(withVerification.truly_correct, true, 'the verification swarm caught the defect and the work was redone');
    assert.equal(withVerification.escaped_defects, 0);
    assert.ok(withVerification.rework >= 1);

    const selfVerified = await runEpisode(candidateDir, seed, { defect_rate: 0.5 });
    assert.equal(selfVerified.injected, withVerification.injected, 'the same seed injects the same defect');
    assert.equal(selfVerified.completed, true, 'the mission still reports success');
    assert.equal(selfVerified.truly_correct, false, 'but the accepted result fails the acceptance criteria');
    assert.ok(selfVerified.escaped_defects >= 1);
    assert.ok(selfVerified.worker_invocations < withVerification.worker_invocations, 'the simpler configuration really is cheaper');
    assert.ok(selfVerified.swarms < withVerification.swarms);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
