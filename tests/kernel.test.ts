import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE, complete, criterion, mission, output, rig, task } from './helpers.ts';
import { SwarmError, amounts } from '../src/lib/util.ts';
import { devAuthority } from '../src/config.ts';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SwarmError) return e.code;
    throw e;
  }
  return 'no_error';
}

test('ownership: one owner per lease, heartbeats extend it, expiry reclaims it', () => {
  const r = rig();
  try {
    const m = mission(r);
    const t = task(r, m, 'a');
    r.kernel.refreshReadiness(m.id);
    const first = r.kernel.claim(t.id, 'worker-1', FIXTURE);
    assert.ok(first, 'first claim succeeds');
    assert.equal(r.kernel.claim(t.id, 'worker-2', FIXTURE), null, 'a second owner cannot take a leased task');

    r.clock.advance(10_000);
    assert.equal(r.kernel.heartbeat(t.id, first.token), true);
    r.clock.advance(10_000);
    assert.equal(r.kernel.expireLeases().length, 0, 'heartbeat kept the lease alive');

    r.clock.advance(20_000);
    const expired = r.kernel.expireLeases();
    assert.equal(expired.length, 1);
    assert.equal(r.store.tasks.must(t.id).status, 'ready', 'expired work is requeued');
    assert.equal(r.kernel.heartbeat(t.id, first.token), false, 'the old owner can no longer heartbeat');
  } finally {
    r.cleanup();
  }
});

test('fencing: a stale worker cannot overwrite a newer attempt', () => {
  const r = rig();
  try {
    const m = mission(r);
    const t = task(r, m, 'a', { required_outputs: [{ key: 'doc/a', kind: 'report', description: 'a' }] });
    r.kernel.refreshReadiness(m.id);
    const stale = r.kernel.claim(t.id, 'worker-1', FIXTURE)!;
    r.clock.advance(60_000);
    r.kernel.expireLeases();
    const fresh = r.kernel.claim(t.id, 'worker-2', FIXTURE)!;
    assert.equal(fresh.token.attempt, stale.token.attempt + 1, 'each lease increments the fencing epoch');

    const good = r.kernel.submitResult(t.id, fresh.token, output({ artifacts: [{ key: 'doc/a', kind: 'report', media_type: 'text/plain', content: 'from worker 2' }] }), null, { source: 'fixture' });
    assert.equal(good.accepted, true);

    const late = r.kernel.submitResult(t.id, stale.token, output({ artifacts: [{ key: 'doc/a', kind: 'report', media_type: 'text/plain', content: 'STALE from worker 1' }] }), null, { source: 'fixture' });
    assert.equal(late.accepted, false, 'the late result is rejected');
    const current = r.kernel.currentVersion(m.id, 'doc/a')!;
    assert.equal(r.kernel.readArtifact(current), 'from worker 2', 'the newer result was not overwritten');
    assert.equal(r.store.events({ type: 'stale_result_rejected' }).length, 1, 'the rejection is recorded');
  } finally {
    r.cleanup();
  }
});

test('dependencies: cycles are rejected and prerequisites gate readiness', () => {
  const r = rig();
  try {
    const m = mission(r);
    const a = task(r, m, 'a');
    const b = task(r, m, 'b', { depends_on: [a.id] });
    const c = task(r, m, 'c', { depends_on: [b.id] });
    assert.equal(code(() => r.kernel.addDependency(a.id, c.id, 'prerequisite')), 'dependency_cycle');
    assert.equal(code(() => r.kernel.addDependency(a.id, a.id, 'prerequisite')), 'dependency_cycle');

    assert.deepEqual(r.kernel.refreshReadiness(m.id).map((t) => t.key), ['a']);
    assert.equal(r.kernel.claim(b.id, 'w', FIXTURE), null, 'b cannot start before a is accepted');
    complete(r, r.store.tasks.must(a.id));
    assert.deepEqual(r.kernel.refreshReadiness(m.id).map((t) => t.key), ['b']);
  } finally {
    r.cleanup();
  }
});

test('teams: children start only after their container, and the container settles from them', () => {
  const r = rig();
  try {
    const m = mission(r);
    const gate = task(r, m, 'gate');
    const team = task(r, m, 'team', { executor: 'container', depends_on: [gate.id], acceptance_criteria: [], verification: { method: 'none', independent: false }, reservation: amounts({ model_calls: 10, worker_invocations: 10, tokens: 20000, cost_usd_est: 1, wall_ms: 120000 }) });
    const kid = task(r, m, 'kid', { parent_task_id: team.id });
    assert.deepEqual(r.kernel.refreshReadiness(m.id).map((t) => t.key), ['gate'], 'the child waits for its team');
    complete(r, r.store.tasks.must(gate.id));
    assert.deepEqual(r.kernel.refreshReadiness(m.id).map((t) => t.key).sort(), ['kid', 'team']);
    complete(r, r.store.tasks.must(kid.id));
    r.kernel.refreshReadiness(m.id);
    assert.equal(r.store.tasks.must(team.id).status, 'accepted');
  } finally {
    r.cleanup();
  }
});

test('budget: children consume the parent budget and cannot create spending authority', () => {
  const r = rig();
  try {
    const m = mission(r, { budget: amounts({ model_calls: 20, worker_invocations: 20, tokens: 100000, cost_usd_est: 2, wall_ms: 600000 }) });
    // delivery share is 60% → 12 invocations
    const team = task(r, m, 'team', { executor: 'container', acceptance_criteria: [], verification: { method: 'none', independent: false }, reservation: amounts({ model_calls: 8, worker_invocations: 8, tokens: 30000, cost_usd_est: 0.6, wall_ms: 200000 }) });
    task(r, m, 'k1', { parent_task_id: team.id, reservation: amounts({ model_calls: 5, worker_invocations: 5, tokens: 10000, cost_usd_est: 0.2, wall_ms: 60000 }) });
    assert.equal(
      code(() => task(r, m, 'k2', { parent_task_id: team.id, reservation: amounts({ model_calls: 5, worker_invocations: 5, tokens: 10000, cost_usd_est: 0.2, wall_ms: 60000 }) })),
      'budget_exceeded',
      'a second child cannot exceed what the team still holds',
    );
    assert.equal(
      code(() => task(r, m, 'big', { reservation: amounts({ model_calls: 6, worker_invocations: 6, tokens: 1000, cost_usd_est: 0.1, wall_ms: 1000 }) })),
      'budget_exceeded',
      'delivery cannot dip into the verification, recovery and completion reserves',
    );
    // the reserves are still intact
    const verification = r.kernel.budget.available(r.kernel.classAccount(m.id, 'verification'));
    assert.equal(verification.worker_invocations, 3);
    const rec = r.kernel.budget.reconcile(m.budget_account_id);
    assert.equal(rec.ok, true, rec.discrepancies.join('; '));
  } finally {
    r.cleanup();
  }
});

test('budget: unspent reservations return to the parent when work settles', () => {
  const r = rig();
  try {
    const m = mission(r);
    const delivery = r.kernel.classAccount(m.id, 'delivery');
    const before = r.kernel.budget.available(delivery).worker_invocations;
    const t = task(r, m, 'a');
    assert.equal(r.kernel.budget.available(delivery).worker_invocations, before - 4);
    r.kernel.refreshReadiness(m.id);
    complete(r, t);
    assert.equal(r.kernel.budget.available(delivery).worker_invocations, before - 1, 'only the one invocation actually used stays spent');
    assert.equal(r.kernel.budget.reconcile(m.budget_account_id).ok, true);
  } finally {
    r.cleanup();
  }
});

test('authority: children inherit narrower authority; outward actions are never delegable', () => {
  const r = rig();
  try {
    const m = mission(r);
    assert.equal(code(() => task(r, m, 'wide', { authority: { ...devAuthority(), tools: ['fs.read', 'network.any'] } })), 'authority_widening');
    assert.equal(code(() => task(r, m, 'drop', { authority: { ...devAuthority(), forbidden_actions: [] } })), 'authority_widening');
    assert.equal(code(() => task(r, m, 'out', { authority: { ...devAuthority(), actions: ['local.reversible', 'merge.protected'] } })), 'authority_widening');
    const parent = task(r, m, 'parent', { executor: 'container', acceptance_criteria: [], verification: { method: 'none', independent: false }, authority: { ...devAuthority(), write_scope: ['src/engine/**'] }, reservation: amounts({ model_calls: 10, worker_invocations: 10, tokens: 20000, cost_usd_est: 1, wall_ms: 120000 }) });
    assert.equal(code(() => task(r, m, 'kid', { parent_task_id: parent.id, authority: { ...devAuthority(), write_scope: ['src/report/**'] } })), 'authority_widening', 'a child cannot write outside its parent scope');
    assert.equal(code(() => mission(r, { authorization: { ...devAuthority(), actions: ['deploy.shared'] } })), 'outward_action_not_delegable');
  } finally {
    r.cleanup();
  }
});

test('delegation depth is capped by operator configuration', () => {
  const r = rig({ max_delegation_depth: 3 });
  try {
    const m = mission(r);
    const big = amounts({ model_calls: 40, worker_invocations: 40, tokens: 100000, cost_usd_est: 4, wall_ms: 600000 });
    const c = { executor: 'container' as const, acceptance_criteria: [], verification: { method: 'none' as const, independent: false } };
    const l1 = task(r, m, 'l1', { ...c, reservation: big });
    const l2 = task(r, m, 'l2', { ...c, parent_task_id: l1.id, reservation: amounts({ model_calls: 20, worker_invocations: 20, tokens: 50000, cost_usd_est: 2, wall_ms: 300000 }) });
    const l3 = task(r, m, 'l3', { parent_task_id: l2.id });
    assert.equal(l3.depth, 3);
    assert.equal(code(() => task(r, m, 'l4', { parent_task_id: l3.id, reservation: amounts({ model_calls: 1, worker_invocations: 1, tokens: 100, cost_usd_est: 0.01, wall_ms: 1000 }) })), 'depth_exceeded');
  } finally {
    r.cleanup();
  }
});

test('invalidation: a changed upstream artifact marks consumers stale and fences in-flight work', () => {
  const r = rig();
  try {
    const m = mission(r);
    const contract = task(r, m, 'contract', { required_outputs: [{ key: 'contract/x', kind: 'contract', description: 'x' }] });
    const engine = task(r, m, 'engine', { depends_on: [contract.id], input_keys: ['contract/x'] });
    const report = task(r, m, 'report', { depends_on: [contract.id], input_keys: ['contract/x'] });
    const later = task(r, m, 'later', { depends_on: [contract.id], input_keys: ['contract/x'] });
    const integrate = task(r, m, 'integrate', { depends_on: [engine.id, report.id] });
    const unrelated = task(r, m, 'unrelated');

    r.kernel.refreshReadiness(m.id);
    complete(r, contract, { artifacts: [{ key: 'contract/x', kind: 'contract', media_type: 'application/json', content: '{"v":1}' }] });
    complete(r, unrelated);
    r.kernel.refreshReadiness(m.id);
    complete(r, r.store.tasks.must(engine.id)); // accepted against v1
    const inflight = r.kernel.claim(report.id, 'w-report', FIXTURE)!; // working against v1
    assert.equal(inflight.task.contract.inputs[0]!.artifact_key, 'contract/x');

    const pub = r.kernel.publishVersion({ mission_id: m.id, key: 'contract/x', kind: 'contract', media_type: 'application/json', content: '{"v":2}', produced_by_task_id: contract.id, produced_by_attempt: 1, inputs: [], release_id: 'r1', source: 'fixture' });
    const byKey = Object.fromEntries(pub.impacts.map((i) => [i.key, i.action]));
    assert.equal(byKey.engine, 'rerun_required');
    assert.equal(byKey.report, 'fenced_in_flight');
    assert.equal(byKey.later, undefined, 'work that never started simply pins the new version later');
    assert.equal(byKey.unrelated, undefined, 'unrelated work is untouched');
    assert.equal(r.store.tasks.must(unrelated.id).status, 'accepted');
    assert.equal(r.store.tasks.must(engine.id).currency, 'needs_revalidation');

    // the fenced worker's late result is rejected
    assert.equal(r.kernel.submitResult(report.id, inflight.token, output(), null, { source: 'fixture' }).accepted, false);

    // a verification from the old generation cannot satisfy the new one
    r.kernel.refreshReadiness(m.id);
    const again = r.kernel.claim(engine.id, 'w-engine', FIXTURE)!;
    assert.equal(again.token.generation, 2);
    assert.match(again.task.contract.inputs[0]!.version_id, /^ver_/);
    assert.equal(again.task.contract.inputs[0]!.content_hash, pub.version.content_hash, 'the rerun pins the exact new version');
    r.kernel.submitResult(engine.id, again.token, output(), null, { source: 'fixture' });
    assert.equal(code(() => r.kernel.acceptTask(engine.id, 'verifier')), 'acceptance_incomplete');
    assert.equal(r.store.tasks.must(integrate.id).status, 'planned');
  } finally {
    r.cleanup();
  }
});

test('reuse: an unchanged input lets a verified result be revalidated without rerunning', () => {
  const r = rig();
  try {
    const m = mission(r);
    const src = task(r, m, 'src');
    const mid = task(r, m, 'mid', { depends_on: [src.id], input_keys: ['doc/src'] });
    const leaf = task(r, m, 'leaf', { depends_on: [mid.id], input_keys: ['doc/mid'] });
    r.kernel.refreshReadiness(m.id);
    complete(r, src, { artifacts: [{ key: 'doc/src', kind: 'report', media_type: 'text/plain', content: 'one' }] });
    r.kernel.refreshReadiness(m.id);
    complete(r, r.store.tasks.must(mid.id), { artifacts: [{ key: 'doc/mid', kind: 'report', media_type: 'text/plain', content: 'derived' }] });
    r.kernel.refreshReadiness(m.id);
    complete(r, r.store.tasks.must(leaf.id));

    r.kernel.publishVersion({ mission_id: m.id, key: 'doc/src', kind: 'report', media_type: 'text/plain', content: 'two', produced_by_task_id: src.id, produced_by_attempt: 1, inputs: [], release_id: 'r1', source: 'fixture' });
    assert.equal(r.store.tasks.must(leaf.id).currency, 'needs_revalidation', 'downstream work is marked, not declared wrong');
    assert.equal(r.kernel.revalidateWithoutRerun(mid.id), false, 'mid consumed the changed input, so it must rerun');

    r.kernel.refreshReadiness(m.id);
    complete(r, r.store.tasks.must(mid.id), { artifacts: [{ key: 'doc/mid', kind: 'report', media_type: 'text/plain', content: 'derived' }] }); // same bytes as before
    assert.equal(r.kernel.revalidateWithoutRerun(leaf.id), true, 'leaf saw identical input content, so its verified result is reused');
    const t = r.store.tasks.must(leaf.id);
    assert.equal(t.status, 'accepted');
    assert.equal(t.attempt, 1, 'leaf was not rerun');
    assert.equal(r.kernel.acceptanceGaps(t).length, 0);
  } finally {
    r.cleanup();
  }
});

test('acceptance needs a passing, independent verification for the current generation', () => {
  const r = rig();
  try {
    const m = mission(r);
    const t = task(r, m, 'a', { acceptance_criteria: [criterion('c1'), criterion('c2'), criterion('opt', { mandatory: false })] });
    r.kernel.refreshReadiness(m.id);
    const lease = r.kernel.claim(t.id, 'author', FIXTURE)!;
    r.kernel.submitResult(t.id, lease.token, output({ criteria_claims: [{ criterion_id: 'c1', claimed: 'met', note: 'trust me' }] }), null, { source: 'fixture' });
    assert.equal(code(() => r.kernel.acceptTask(t.id, 'x')), 'acceptance_incomplete', 'a claim is not a verification');
    r.kernel.recordVerification({ task_id: t.id, criterion_id: 'c1', method: 'executable', verdict: 'pass', verifier_id: 'author' });
    r.kernel.recordVerification({ task_id: t.id, criterion_id: 'c2', method: 'executable', verdict: 'pass', verifier_id: 'verifier' });
    assert.equal(code(() => r.kernel.acceptTask(t.id, 'x')), 'acceptance_incomplete', 'self-verification is not independent');
    r.kernel.recordVerification({ task_id: t.id, criterion_id: 'c1', method: 'executable', verdict: 'pass', verifier_id: 'verifier' });
    assert.equal(r.kernel.acceptTask(t.id, 'x').status, 'accepted');
  } finally {
    r.cleanup();
  }
});

test('rework is bounded by the repair limit', () => {
  const r = rig({ max_repair_attempts: 1 });
  try {
    const m = mission(r);
    const t = task(r, m, 'a');
    r.kernel.refreshReadiness(m.id);
    let lease = r.kernel.claim(t.id, 'w', FIXTURE)!;
    r.kernel.submitResult(t.id, lease.token, output(), null, { source: 'fixture' });
    assert.equal(r.kernel.rejectTask(t.id, 'verifier', 'tests fail').status, 'ready');
    lease = r.kernel.claim(t.id, 'w', FIXTURE)!;
    r.kernel.submitResult(t.id, lease.token, output(), null, { source: 'fixture' });
    assert.equal(r.kernel.rejectTask(t.id, 'verifier', 'tests still fail').status, 'failed');
    assert.equal(r.store.observations.where(`"kind" = 'rework'`).length, 2);
  } finally {
    r.cleanup();
  }
});

test('idempotency: duplicates are no-ops; a reused key with a different body is quarantined', () => {
  const r = rig();
  try {
    const cmd = { command: 'createMission', actor: 'chief_of_staff', key: 'dup-1', data: { title: 't', objective: 'o', priority: 1, requested_by: 'cos', accountable_human: 'paul', authorization: devAuthority(), budget: amounts({ model_calls: 10, worker_invocations: 10, tokens: 1000, cost_usd_est: 1, wall_ms: 1000 }), data_class: 'synthetic' as const, provider_mode: 'fixture' as const, scenario: null, request_ids: [], release_id: 'r1' } };
    const a = r.kernel.createMission(cmd);
    const b = r.kernel.createMission(cmd);
    assert.equal(a.id, b.id, 'the duplicate returns the original result');
    assert.equal(r.store.missions.count(), 1);
    assert.equal(r.store.events({ type: 'duplicate_delivery_ignored' }).length, 1);
    assert.equal(code(() => r.kernel.createMission({ ...cmd, data: { ...cmd.data, title: 'different' } })), 'idempotency_conflict');
    assert.equal(r.store.events({ type: 'idempotency_conflict_quarantined' }).length, 1);
    assert.equal(r.store.missions.count(), 1);
  } finally {
    r.cleanup();
  }
});

test('cancellation propagates to descendants, releases reservations and keeps artifacts', () => {
  const r = rig();
  try {
    const m = mission(r);
    const delivery = r.kernel.classAccount(m.id, 'delivery');
    const before = r.kernel.budget.available(delivery).worker_invocations;
    const team = task(r, m, 'team', { executor: 'container', acceptance_criteria: [], verification: { method: 'none', independent: false }, reservation: amounts({ model_calls: 12, worker_invocations: 12, tokens: 30000, cost_usd_est: 1.5, wall_ms: 200000 }) });
    const done = task(r, m, 'done', { parent_task_id: team.id });
    const running = task(r, m, 'running', { parent_task_id: team.id });
    task(r, m, 'waiting', { parent_task_id: team.id, depends_on: [running.id] });
    r.kernel.refreshReadiness(m.id);
    complete(r, r.store.tasks.must(done.id), { artifacts: [{ key: 'doc/kept', kind: 'report', media_type: 'text/plain', content: 'useful' }] });
    const lease = r.kernel.claim(running.id, 'w', FIXTURE)!;

    const res = r.kernel.cancelMission({ command: 'cancelMission', actor: 'chief_of_staff', key: 'cancel-1', data: { mission_id: m.id, reason: 'priority changed' } });
    assert.deepEqual(res.cancelled.sort(), ['running', 'team', 'waiting']);
    assert.equal(r.store.tasks.must(done.id).status, 'accepted', 'settled work is not rewritten');
    assert.equal(r.kernel.readArtifact(r.kernel.currentVersion(m.id, 'doc/kept')!), 'useful', 'useful artifacts are preserved');
    assert.equal(r.kernel.submitResult(running.id, lease.token, output(), null, { source: 'fixture' }).accepted, false, 'orphaned work cannot land');
    assert.equal(r.kernel.activeCalls(), 0, 'call slots are released');
    assert.equal(r.kernel.budget.available(delivery).worker_invocations, before - 2, 'only what was actually spent stays spent');
  } finally {
    r.cleanup();
  }
});

test('concurrency: the call-slot cap is enforced and survives recovery', () => {
  const r = rig({ max_concurrent_model_calls: 2 });
  try {
    const m = mission(r);
    const ts = ['a', 'b', 'c'].map((k) => task(r, m, k));
    r.kernel.refreshReadiness(m.id);
    assert.ok(r.kernel.claim(ts[0]!.id, 'w1', FIXTURE));
    assert.ok(r.kernel.claim(ts[1]!.id, 'w2', FIXTURE));
    assert.equal(r.kernel.claim(ts[2]!.id, 'w3', FIXTURE), null, 'the third call waits for a slot');
    assert.equal(r.store.tasks.must(ts[2]!.id).status, 'ready', 'back-pressure is not a failure');

    const rec = r.kernel.recover(); // coordinator restarted: both attempts were in flight
    assert.equal(rec.orphaned_attempts.length, 2);
    assert.equal(r.kernel.activeCalls(), 0);
    assert.equal(r.store.tasks.must(ts[0]!.id).status, 'ready');
    assert.ok(rec.budgets.every((b) => b.ok));
    const again = r.kernel.claim(ts[0]!.id, 'w1b', FIXTURE)!;
    assert.equal(again.token.attempt, 2, 'the resumed attempt gets a new fencing epoch');
  } finally {
    r.cleanup();
  }
});

test('a provider capacity failure blocks without burning retries', () => {
  const r = rig();
  try {
    const m = mission(r);
    const t = task(r, m, 'a');
    r.kernel.refreshReadiness(m.id);
    const lease = r.kernel.claim(t.id, 'w', FIXTURE)!;
    const after = r.kernel.failAttempt(t.id, lease.token, 'rate_limited', { code: 'rate_limited', message: 'limit reached; resets later' }, null, { countsAsRetry: false });
    assert.equal(after.status, 'blocked');
    assert.equal(after.blocked_reason, 'provider_rate_limited');
    assert.equal(after.retries, 0);
    assert.equal(after.next_action?.owner_kind, 'operator');
    assert.equal(r.kernel.unblock(t.id, 'operator', 'capacity restored').status, 'ready');
  } finally {
    r.cleanup();
  }
});

test('the event log is append-only and hash-chained', () => {
  const r = rig();
  try {
    const m = mission(r);
    task(r, m, 'a');
    const chain = r.store.verifyEventChain();
    assert.equal(chain.ok, true);
    assert.ok(chain.count >= 2);
    assert.throws(() => r.store.db.run(`UPDATE events SET type = 'tampered' WHERE seq = 1`), /append-only/);
    assert.throws(() => r.store.db.run(`DELETE FROM events WHERE seq = 1`), /append-only/);
  } finally {
    r.cleanup();
  }
});
