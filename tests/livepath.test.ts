import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doing } from '../src/api/views.ts';
import type { UsageRecord, WorkOutput } from '../src/contracts/types.ts';
import { Coordinator } from '../src/coordination/coordinator.ts';
import { LocalChiefOfStaff } from '../src/cos/port.ts';
import { interpretResult } from '../src/providers/claude-cli.ts';
import type { Provider, WorkRequest, WorkResult } from '../src/providers/provider.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/config.ts';
import { liveRunName } from '../demos/lib.ts';
import { freshRuntime } from './e2e.ts';

/**
 * STAND-IN FOR THE MODEL. No model is called anywhere in this file. The stand-in hands results to
 * the coordinator the way the live provider does (a scripted worker writes its own result to the
 * store instead), so the path real workers take is exercised without real workers.
 */
function standIn(script: ((n: number) => WorkResult)[]): Provider & { calls: number; deadlines: number[] } {
  const p = {
    name: 'stand-in',
    mode: 'live' as const,
    guarantees: 'A test stand-in. It calls no model.',
    calls: 0,
    deadlines: [] as number[],
    available: () => ({ ok: true, reason: null }),
    start: (req: WorkRequest) => {
      p.deadlines.push(req.timeout_ms);
      const n = p.calls++;
      const result = (script[n] ?? script[script.length - 1]!)(n);
      return { pid: null, done: Promise.resolve(result), kill: () => undefined };
    },
  };
  return p;
}

const reported = (output_units: number): UsageRecord => ({ source: 'stand-in', meter_kind: 'provider_reported', call_count: 1, input_units: 10, output_units, cache_read_units: 0, cache_write_units: 0, wall_ms: 900, reported_cost: 0.01, currency: 'USD', cost_basis: 'list_price_estimate', completeness: 'complete', observed_at: new Date().toISOString() });
const written: WorkOutput = { status: 'completed', summary: 'Three risks, written out.', artifacts: [{ key: 'result/summary', kind: 'report', media_type: 'text/plain', content: 'one; two; three' }], evidence: [], criteria_claims: [], remaining_uncertainty: [], questions: [], proposals: [] };
const good = (): WorkResult => ({ status: 'ok', output: written, self_submitted: false, usage: reported(500), model_requested: 'stand-in', model_actual: 'stand-in', session_id: null, error: null });
const stopped = (): WorkResult => interpretResult(null, { model_requested: 'stand-in', wall_ms: 22_000, exit_code: 143, signal: null, timed_out: true, expects_structured: true });

test('the path a live worker takes: an attempt stopped at its deadline, a result that cannot be recorded, then a good one', async () => {
  const { rt, cleanup } = freshRuntime();
  const provider = standIn([stopped, good, good]);
  (rt.providers as { live: Provider }).live = provider;
  const co = new Coordinator(rt);
  try {
    const cos = new LocalChiefOfStaff(rt);
    const sub = cos.submitMission({ command: 'submitMission', actor: 'chief_of_staff', key: 'livepath', data: { title: 'Name three risks', objective: 'produce a short written result', provider_mode: 'live' } });
    assert.ok(sub.source !== 'unavailable');
    const id = sub.mission.id;
    // INJECTED FAULT: the first result the coordinator tries to record cannot be recorded.
    const record = rt.kernel.submitResult.bind(rt.kernel);
    let refused = 0;
    rt.kernel.submitResult = ((...args: Parameters<typeof record>) => {
      if (refused++ === 0) throw new Error('INJECTED: this result cannot be recorded');
      return record(...args);
    }) as typeof rt.kernel.submitResult;

    // First pass: the one task is dispatched and its worker is stopped at the deadline.
    await co.tick(id);
    await co.drain();
    const shownMidway = (doing(rt) as unknown as { missions: { id: string; unreported_usage_attempts: number }[] }).missions.find((m) => m.id === id)!;
    assert.equal(shownMidway.unreported_usage_attempts, 1, 'while the mission is under way, the interface is told its totals are a lower bound');

    assert.equal(await co.runUntilIdle({ mission_id: id, max_ms: 30_000 }), 'idle');
    await co.drain();
    assert.equal(rt.store.missions.must(id).status, 'review_ready', 'neither failure stranded the work');
    const task = rt.store.tasks.first(`"mission_id" = ? AND "executor" = 'worker'`, id)!;
    const attempts = rt.store.attempts.where('"task_id" = ?', task.id).sort((a, b) => a.attempt_no - b.attempt_no);
    assert.deepEqual(attempts.map((a) => a.status), ['failed', 'invalid_output', 'succeeded']);
    assert.equal(attempts[0]!.error?.code, 'timeout');
    assert.equal(attempts[0]!.usage?.completeness, 'unknown', 'the stopped attempt keeps what was measured and marks the rest unknown');
    assert.match(attempts[1]!.error?.message ?? '', /INJECTED: this result cannot be recorded/, 'a result that cannot be recorded fails its attempt instead of leaving the task leased');
    assert.equal(provider.calls, 3);
    assert.ok(provider.deadlines.every((d) => d >= rt.limits.live_attempt_floor_ms), 'each attempt was given at least the live floor as its deadline');

    // Every place a person reads spend from says the total is a lower bound.
    const progress = cos.inspectProgress(id);
    assert.ok(progress.source !== 'unavailable');
    const snap = progress.missions[0]!;
    assert.deepEqual(snap.execution, { model_attempts: 3, scripted_attempts: 0, runtime_steps: 0, unreported_usage_attempts: 1 });
    assert.equal(snap.spent.model_calls, 3, 'three invocations, counted once each');
    assert.equal(snap.spent.tokens, 2 * 510, 'tokens only from the two attempts that reported them');
    assert.equal(snap.spent.wall_ms, 22_000 + 900 + 900);
    assert.equal(rt.kernel.budget.reconcile(rt.store.missions.must(id).budget_account_id).ok, true);
  } finally {
    co.stop();
    cleanup();
  }
});

test('a live run never replaces a kept evidence bundle unless that is asked for', () => {
  const before = process.env.SWARM2_OVERWRITE;
  delete process.env.SWARM2_OVERWRITE;
  try {
    for (const kept of ['live-a', 'live-b', 'live-c', 'live-improve', 'live-improve-2']) {
      assert.ok(existsSync(join(REPO_ROOT, 'evidence', kept)), `${kept} is a kept bundle`);
      assert.throws(() => liveRunName(kept, 'live'), /already exists and is not overwritten/);
    }
    const fresh = liveRunName(undefined, 'live', new Date('2026-11-14T22:05:09.123Z'));
    assert.equal(fresh, 'live-20261114-220509', 'without a name, a run gets a new one');
    assert.equal(liveRunName('live-x', 'live'), 'live-x');
    for (const bad of ['../live-a', 'a/b', '.', '', 'live a']) assert.throws(() => liveRunName(bad, 'live'), /not a usable run name/);
    process.env.SWARM2_OVERWRITE = '1';
    assert.equal(liveRunName('live-a', 'live'), 'live-a', 'replacing a bundle takes an explicit setting');
  } finally {
    if (before === undefined) delete process.env.SWARM2_OVERWRITE;
    else process.env.SWARM2_OVERWRITE = before;
  }
});
