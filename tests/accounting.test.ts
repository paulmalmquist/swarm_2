import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE, mission, output, rig, task } from './helpers.ts';
import { amounts } from '../src/lib/util.ts';
import { interpretResult } from '../src/providers/claude-cli.ts';
import { attemptDeadlineMs } from '../src/coordination/coordinator.ts';
import { DEV_PROFILE } from '../src/config.ts';
import type { UsageRecord } from '../src/contracts/types.ts';

const LIVE = { provider: 'claude-cli', provider_mode: 'live' as const, model_requested: 'haiku', uses_call_slot: true };
const one = amounts({ model_calls: 1, worker_invocations: 1, tokens: 10000, cost_usd_est: 0.5, wall_ms: 60000 });

/** What the live provider returns when the client was stopped before it reported anything. */
function stoppedAtDeadline(wall_ms: number): UsageRecord {
  const res = interpretResult(null, { model_requested: 'haiku', wall_ms, exit_code: 143, signal: null, timed_out: true, expects_structured: true });
  assert.equal(res.status, 'timeout');
  return res.usage!;
}

test('a model attempt stopped at its deadline is charged what was measured, and the rest is marked unknown', () => {
  const usage = stoppedAtDeadline(22_000);
  assert.equal(usage.completeness, 'unknown', 'the client never said what it used');
  assert.equal(usage.meter_kind, 'runtime_measured');
  assert.equal(usage.call_count, 1, 'the invocation happened');
  assert.equal(usage.wall_ms, 22_000, 'and so did the time');
  assert.equal(usage.output_units, null, 'tokens are unknown, not zero');
  assert.equal(usage.reported_cost, null, 'cost is unknown, not zero');

  const r = rig();
  try {
    const m = mission(r);
    const t = task(r, m, 'a');
    r.kernel.refreshReadiness(m.id);
    assert.equal(r.kernel.unreportedUsage(m.id), 0);
    const lease = r.kernel.claim(t.id, 'w', LIVE)!;
    r.kernel.failAttempt(t.id, lease.token, 'failed', { code: 'timeout', message: 'worker ended without a result' }, usage, { countsAsRetry: true });
    const spent = r.kernel.budget.spent(m.budget_account_id);
    assert.deepEqual(spent, amounts({ model_calls: 1, worker_invocations: 1, tokens: 0, cost_usd_est: 0, wall_ms: 22_000 }));
    assert.equal(r.kernel.unreportedUsage(m.id), 1, 'so the mission knows its token and cost totals are lower bounds');

    // An attempt refused for lack of capacity made no call: it is not a gap in the usage record.
    const again = r.kernel.claim(t.id, 'w', LIVE)!;
    r.kernel.failAttempt(t.id, again.token, 'rate_limited', { code: 'rate_limited', message: 'limit reached' }, null, { countsAsRetry: false });
    assert.equal(r.kernel.unreportedUsage(m.id), 1);
  } finally {
    r.cleanup();
  }
});

test('a retry paid from the recovery reserve moves allowance; it is never counted as spent', () => {
  const r = rig();
  try {
    const m = mission(r);
    // A team with no slack: it holds exactly what its one member reserved.
    const team = task(r, m, 'team', { executor: 'container', acceptance_criteria: [], verification: { method: 'none', independent: false }, reservation: one });
    const t = task(r, m, 'kid', { parent_task_id: team.id, reservation: one });
    r.kernel.refreshReadiness(m.id);
    const recovery = r.kernel.classAccount(m.id, 'recovery');
    const reserveBefore = r.kernel.budget.available(recovery);

    const first = r.kernel.claim(t.id, 'w', LIVE)!;
    r.kernel.failAttempt(t.id, first.token, 'failed', { code: 'timeout', message: 'worker ended without a result' }, stoppedAtDeadline(22_000), { countsAsRetry: true });
    assert.equal(r.kernel.budget.available(t.budget_account_id).worker_invocations, 0, 'the task has used the one invocation it reserved');

    const second = r.kernel.claim(r.store.tasks.must(t.id).id, 'w', LIVE);
    assert.ok(second, 'the retry is paid for from the recovery reserve');
    assert.equal(r.store.events({ type: 'recovery_reserve_used' }).length, 1);
    assert.deepEqual(r.kernel.budget.spent(m.budget_account_id), amounts({ model_calls: 1, worker_invocations: 1, tokens: 0, cost_usd_est: 0, wall_ms: 22_000 }), 'moving allowance is not spending: the mission has spent only what its one attempt used');
    assert.equal(r.kernel.budget.available(recovery).worker_invocations, reserveBefore.worker_invocations - 1, 'the reserve gave it up');
    assert.equal(r.kernel.budget.available(recovery).tokens, reserveBefore.tokens - 5000);
    assert.equal(r.store.accounts.must(t.budget_account_id).limit.worker_invocations, 2, 'the task received it');
    assert.equal(r.store.accounts.must(r.store.tasks.must(team.id).budget_account_id).limit.worker_invocations, 2, 'and so did the team above it, so no account holds more than its parent gave');
    const rec = r.kernel.budget.reconcile(m.budget_account_id);
    assert.equal(rec.ok, true, rec.discrepancies.join('; '));

    const used: UsageRecord = { source: 'claude-cli', meter_kind: 'provider_reported', call_count: 1, input_units: 10, output_units: 500, cache_read_units: 0, cache_write_units: 0, wall_ms: 5000, reported_cost: 0.01, currency: 'USD', cost_basis: 'list_price_estimate', completeness: 'complete', observed_at: r.clock.iso() };
    r.kernel.submitResult(t.id, second.token, output(), used, { source: 'live' });
    assert.deepEqual(r.kernel.budget.spent(m.budget_account_id), amounts({ model_calls: 2, worker_invocations: 2, tokens: 510, cost_usd_est: 0.01, wall_ms: 27_000 }), 'two attempts ran, and two attempts are what was spent');
    assert.equal(r.kernel.budget.reconcile(m.budget_account_id).ok, true);
  } finally {
    r.cleanup();
  }
});

test('allowance can only be moved if the giver has it, and the move is visible in the ledger', () => {
  const r = rig();
  try {
    const m = mission(r);
    const t = task(r, m, 'a', { reservation: one });
    const recovery = r.kernel.classAccount(m.id, 'recovery');
    const have = r.kernel.budget.available(recovery);
    const tooMuch = amounts({ worker_invocations: have.worker_invocations + 1 });
    assert.equal(r.kernel.budget.transfer(recovery, t.budget_account_id, tooMuch, 'test'), false, 'the reserve cannot give what it does not hold');
    assert.equal(r.store.accounts.must(t.budget_account_id).limit.worker_invocations, 1, 'and a refused move changes nothing');

    assert.equal(r.kernel.budget.transfer(recovery, t.budget_account_id, amounts({ worker_invocations: 1 }), 'test'), true);
    const kinds = r.store.db.all<{ kind: string }>(`SELECT kind FROM budget_ledger WHERE ref = 'test' ORDER BY seq`).map((x) => x.kind);
    assert.deepEqual([...new Set(kinds)].sort(), ['transfer_in', 'transfer_out']);
    assert.equal(r.kernel.budget.reconcile(m.budget_account_id).ok, true);

    // A limit changed behind the ledger's back is caught.
    const acct = r.store.accounts.must(t.budget_account_id);
    acct.limit = { ...acct.limit, worker_invocations: acct.limit.worker_invocations + 5 };
    r.store.accounts.put(acct);
    const rec = r.kernel.budget.reconcile(m.budget_account_id);
    assert.equal(rec.ok, false);
    assert.ok(rec.discrepancies.some((d) => /stored limit differs from ledger/.test(d)), rec.discrepancies.join('; '));
  } finally {
    r.cleanup();
  }
});

test('work that keeps timing out is an execution failure, not an acceptance failure', () => {
  const r = rig();
  try {
    const m = mission(r);
    const t = task(r, m, 'a');
    r.kernel.refreshReadiness(m.id);
    for (let i = 0; i < DEV_PROFILE.max_retries_per_task + 1; i++) {
      const lease = r.kernel.claim(t.id, 'w', FIXTURE)!;
      assert.ok(lease, `attempt ${i + 1} is dispatched`);
      r.kernel.failAttempt(t.id, lease.token, 'failed', { code: 'timeout', message: 'worker ended without a result' }, null, { countsAsRetry: true });
    }
    assert.equal(r.store.tasks.must(t.id).status, 'failed', 'the retry limit is a ceiling');
    const kinds = r.store.observations.where('"mission_id" = ?', m.id).map((o) => o.kind);
    assert.deepEqual(kinds, ['execution_failure'], 'nothing was produced that a criterion could be checked against');
    assert.equal(r.store.observations.where('"mission_id" = ?', m.id)[0]!.failure_class, 'timeout');
  } finally {
    r.cleanup();
  }
});

test('a live attempt gets at least the configured floor before it is stopped', () => {
  const floor = DEV_PROFILE.live_attempt_floor_ms;
  assert.equal(attemptDeadlineMs('live', DEV_PROFILE, 21_600), floor, 'a small share of the time budget is not a deadline for a model call');
  assert.equal(attemptDeadlineMs('live', DEV_PROFILE, floor * 2), floor * 2, 'a larger reservation is honoured');
  assert.equal(attemptDeadlineMs('fixture', DEV_PROFILE, 21_600), 21_600, 'scripted workers keep the reservation as their deadline');
  assert.equal(attemptDeadlineMs('fixture', DEV_PROFILE, 100), 5_000);
});
