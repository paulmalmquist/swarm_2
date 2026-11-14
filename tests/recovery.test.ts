import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/config.ts';
import { applyUpstreamChange } from '../src/coordination/changes.ts';
import { freshHome, injectFaults, scenarioRequests, startCoordinator, submitSharedCapability, waitFor } from '../demos/lib.ts';
import { pidAlive } from '../src/lib/util.ts';

const ENV = { SWARM2_LEASE_MS: '1500' };

test('recovery: a killed worker, a stale result, a coordinator restart, a duplicate and an upstream revision', async () => {
  const home = mkdtempSync(join(tmpdir(), 'swarm2-recovery-'));
  const rt = freshHome(home, { lease_ms: 1500 });
  const procs: { child: { kill(s?: NodeJS.Signals): boolean } }[] = [];
  try {
    const { cos, mission_id } = submitSharedCapability(rt, 'rec');
    injectFaults(rt, mission_id, [
      { task_key: 'delivery.engine.implement', attempt: 1, fault: 'slow:8000' },
      { task_key: 'delivery.report.implement', attempt: 1, fault: 'stall_then_submit:3500' },
      { task_key: 'reliability.knowledge', attempt: 1, fault: 'slow:8000' },
    ]);
    const task = (key: string) => rt.store.tasks.first('"mission_id" = ? AND "key" = ?', mission_id, key);
    const attempt = (key: string, n: number) => {
      const t = task(key);
      return t ? rt.kernel.attemptFor(t.id, n) : undefined;
    };

    // ── 1. kill a worker ────────────────────────────────────────────────
    const c1 = startCoordinator(home, { env: ENV });
    procs.push(c1);
    const enginePid = await waitFor(() => { const a = attempt('delivery.engine.implement', 1); return a?.status === 'running' && a.pid ? a.pid : null; }, 30_000, 'engine worker to start');
    process.kill(enginePid, 'SIGKILL');
    await waitFor(() => attempt('delivery.engine.implement', 2), 15_000, 'engine to be re-leased');
    assert.equal(attempt('delivery.engine.implement', 1)!.status, 'killed');
    assert.equal(task('delivery.engine.implement')!.attempt, 2, 'ownership moved to a new attempt with a new fencing epoch');

    // ── 2. a presumed-dead worker comes back with a stale result ────────
    const stale = await waitFor(() => rt.store.events({ mission_id, type: 'stale_result_rejected' }).find((e) => e.payload.key === 'delivery.report.implement'), 20_000, 'the stale report result to be rejected');
    assert.equal(stale.payload.presented, 'g1a1');
    assert.equal(attempt('delivery.report.implement', 1)!.status, 'expired');
    assert.ok(rt.store.events({ mission_id, type: 'lease_expired' }).some((e) => e.payload.key === 'delivery.report.implement'));

    // ── 3. kill the coordinator mid-flight and start another ────────────
    const knowledgePid = await waitFor(() => { const a = attempt('reliability.knowledge', 1); return a?.status === 'running' && a.pid ? a.pid : null; }, 40_000, 'knowledge worker to start');
    c1.child.kill('SIGKILL');
    await c1.exited;
    assert.ok(pidAlive(knowledgePid), 'the worker outlives the coordinator that started it');
    const c2 = startCoordinator(home, { env: ENV });
    procs.push(c2);
    assert.equal(await c2.exited, 0);
    assert.ok(rt.store.events({ mission_id, type: 'attempt_orphaned' }).some((e) => e.payload.key === 'reliability.knowledge'), 'the in-flight attempt was fenced on restart');
    assert.equal(pidAlive(knowledgePid), false, 'the orphaned worker was stopped');
    assert.equal(rt.store.missions.must(mission_id).status, 'review_ready', 'the new coordinator finished the mission from persisted state');
    assert.equal(task('reliability.knowledge')!.attempt, 2);

    // ── 4. duplicate delivery ───────────────────────────────────────────
    const m0 = rt.store.missions.must(mission_id);
    const redelivered = cos.ingestRequests({ command: 'ingestRequests', actor: 'chief_of_staff', key: 'rec-ingest', data: { requests: scenarioRequests() } });
    assert.ok(redelivered.source !== 'unavailable' && redelivered.duplicates === 5 && redelivered.received === 0, 'redelivered requests are ignored');
    const submit = { command: 'submitMission', actor: 'chief_of_staff', key: 'rec-submit', data: { title: m0.title, objective: m0.objective, request_ids: m0.request_ids, scenario: 'shared-capability', priority: 2 } };
    const again = cos.submitMission(submit);
    assert.ok(again.source !== 'unavailable' && again.mission.id === mission_id, 'a duplicate command returns the original mission');
    assert.equal(rt.store.missions.count(), 1);
    assert.throws(() => cos.submitMission({ ...submit, data: { ...submit.data, title: 'a different body under the same key' } }), /reused with a different body/);
    assert.equal(rt.store.missions.count(), 1, 'the conflicting duplicate was quarantined, not applied');
    assert.ok(rt.store.events({ type: 'duplicate_delivery_ignored' }).length >= 6);
    assert.equal(rt.store.events({ type: 'idempotency_conflict_quarantined' }).length, 1);

    // ── 5. revise the upstream contract ─────────────────────────────────
    const before = Object.fromEntries(['discovery.analyze', 'planning.criteria', 'planning.plan', 'delivery.decompose'].map((k) => [k, task(k)!.attempt]));
    const firstReview = rt.store.getMeta<{ decision_id: string; draft_id: string }>(`mission:${mission_id}:review`)!;
    const v2 = readFileSync(join(REPO_ROOT, 'fixtures/scenarios/shared-capability/contracts/health-record.v2.json'), 'utf8');
    const change = applyUpstreamChange(rt, { command: 'applyUpstreamChange', actor: 'chief_of_staff', key: 'rec-revise', data: { mission_id, key: 'contract/health-record', content: v2, reason: 'the weekly review needs a severity ranking' } });
    const impact = Object.fromEntries(change.impacts.map((i) => [i.key, i.action]));
    assert.equal(impact['delivery.engine.implement'], 'rerun_required');
    assert.equal(impact['delivery.report.implement'], 'rerun_required');
    assert.equal(impact['delivery.integrate'], 'downstream_blocked');
    assert.equal(impact['review.packet'], 'downstream_blocked');
    assert.equal(impact['discovery.analyze'], undefined, 'work that did not consume the contract is untouched');
    assert.equal(rt.store.missions.must(mission_id).status, 'active', 'the mission is reopened');
    assert.equal(rt.store.decisions.must(firstReview.decision_id).status, 'superseded', 'the stale review decision cannot be approved by mistake');
    assert.equal(rt.store.drafts.must(firstReview.draft_id).status, 'withdrawn');

    const c3 = startCoordinator(home, { env: ENV });
    procs.push(c3);
    assert.equal(await c3.exited, 0);
    assert.equal(rt.store.missions.must(mission_id).status, 'review_ready');
    for (const [k, n] of Object.entries(before)) assert.equal(task(k)!.attempt, n, `${k} was not rerun`);
    const integrate = task('delivery.integrate')!;
    const vs = rt.store.verifications.where('"task_id" = ? AND "generation" = ?', integrate.id, integrate.generation);
    assert.ok(integrate.generation >= 2);
    assert.ok(vs.length === 5 && vs.every((v) => v.verdict === 'pass' && v.independent), 'the result was verified again against the new contract');
    const ev = cos.retrieveEvidence(mission_id);
    assert.ok(ev.source !== 'unavailable');
    assert.ok(ev.packet!.artifacts.some((a) => a.key === 'contract/health-record' && a.version_no === 2));
    assert.notEqual(rt.store.getMeta<{ decision_id: string }>(`mission:${mission_id}:review`)!.decision_id, firstReview.decision_id, 'a fresh decision was requested');
    assert.equal(rt.kernel.budget.reconcile(rt.store.missions.must(mission_id).budget_account_id).ok, true);
    assert.equal(rt.store.verifyEventChain().ok, true);
  } finally {
    for (const p of procs) p.child.kill('SIGKILL');
    rt.close();
    rmSync(home, { recursive: true, force: true });
  }
});
