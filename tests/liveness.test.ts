import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/config.ts';
import type { Mission, Task } from '../src/contracts/types.ts';
import { Coordinator } from '../src/coordination/coordinator.ts';
import { materializePlan } from '../src/coordination/plan.ts';
import { LocalChiefOfStaff } from '../src/cos/port.ts';
import type { CoordinationDef } from '../src/contracts/definitions.ts';
import type { Runtime } from '../src/runtime.ts';
import { decomposePlan } from '../fixtures/scenarios/shared-capability/plan.ts';
import { freshRuntime } from './e2e.ts';

const UNATTENDED = { provider: 'fixture', provider_mode: 'fixture' as const, model_requested: null, uses_call_slot: false };

/** A one-agent mission whose single task is ready and has not been handed to any worker yet. */
async function readyTask(rt: Runtime, co: Coordinator, key: string): Promise<{ cos: LocalChiefOfStaff; mission: Mission; task: Task }> {
  const cos = new LocalChiefOfStaff(rt);
  const sub = cos.submitMission({ command: 'submitMission', actor: 'chief_of_staff', key, data: { title: `liveness ${key}`, objective: 'produce a short written result' } });
  assert.ok(sub.source !== 'unavailable');
  const mission = sub.mission;
  const scenario = await co.scenario(mission);
  materializePlan(rt.kernel, mission, scenario.bootstrapPlan({ mission, defs: co.defs(mission.release_id) }), null);
  for (let i = 0; i < 5; i++) rt.kernel.refreshReadiness(mission.id);
  const task = rt.store.tasks.first(`"mission_id" = ? AND "executor" = 'worker' AND "status" = 'ready'`, mission.id);
  assert.ok(task, 'the worker task is ready');
  return { cos, mission, task };
}

test('a coordinator does not report idle while a lease is outstanding; an abandoned lease is reclaimed and the work finishes', async () => {
  const { rt, cleanup } = freshRuntime({ lease_ms: 1500 });
  const co = new Coordinator(rt);
  try {
    const { mission, task } = await readyTask(rt, co, 'stranded');
    // A lease nobody is serving: its holder is gone and no process of this coordinator is attached.
    const abandoned = rt.kernel.claim(task.id, task.owner_id, UNATTENDED)!;
    assert.equal(rt.store.tasks.must(task.id).status, 'leased');

    const state = await co.runUntilIdle({ mission_id: mission.id, max_ms: 30_000 });
    await co.drain();
    assert.equal(state, 'idle');
    assert.equal(rt.store.missions.must(mission.id).status, 'review_ready', 'idle was not reported while the work was stranded');
    const after = rt.store.tasks.must(task.id);
    assert.equal(after.status, 'accepted');
    assert.equal(after.attempt, abandoned.token.attempt + 1, 'the lease ran out and the work was leased again under a new token');
    assert.equal(rt.kernel.attemptFor(task.id, abandoned.token.attempt)!.status === 'succeeded', false, 'the abandoned attempt is not what completed it');
  } finally {
    co.stop();
    cleanup();
  }
});

test('a worker that reports it cannot proceed reaches a person, who can send the work back with what was said', async () => {
  const { rt, cleanup } = freshRuntime();
  const co = new Coordinator(rt);
  try {
    const { cos, mission, task } = await readyTask(rt, co, 'blocked');
    const lease = rt.kernel.claim(task.id, task.owner_id, UNATTENDED)!;
    const said = 'I cannot proceed: the objective names a dataset that is not among my inputs.';
    rt.kernel.submitResult(task.id, lease.token, { status: 'blocked', summary: said, artifacts: [], evidence: [], criteria_claims: [], remaining_uncertainty: [], questions: [], proposals: [] }, null, { source: 'fixture' });
    assert.equal(rt.store.tasks.must(task.id).status, 'blocked');
    assert.equal(rt.store.tasks.must(task.id).blocked_reason, 'worker_blocked');

    await co.tick(mission.id);
    const d = rt.store.decisions.first(`"mission_id" = ? AND "kind" = 'blocked_work' AND "status" = 'open'`, mission.id)!;
    assert.ok(d, 'the question goes to a person, not to an agent that cannot act on it');
    assert.equal(d.owner_kind, 'chief_of_staff');
    assert.equal(d.requires_human, true);
    assert.match(d.question, /not among my inputs/, 'with what the worker said');
    assert.deepEqual(d.options.map((o) => o.id), ['retry', 'cancel', 'hold']);
    const att = cos.attention();
    assert.ok(att.source !== 'unavailable' && att.items.some((i) => i.id === d.id));
    await co.tick(mission.id);
    assert.equal(rt.store.decisions.where(`"mission_id" = ? AND "kind" = 'blocked_work'`, mission.id).length, 1, 'asked once, not on every pass');

    const res = cos.resolveDecision({ command: 'resolveDecision', actor: 'paul', key: 'blocked-retry', data: { decision_id: d.id, chosen: 'retry', rationale: 'the dataset is described in the objective; work from that' } });
    assert.ok(res.source !== 'unavailable' && /another attempt/.test(res.effect));
    assert.match(rt.store.getMeta<{ reason: string }>(`task:${task.id}:rework`)!.reason, /previous worker reported it was blocked: I cannot proceed/, 'the next worker is told what stopped the last one');
    await co.runUntilIdle({ mission_id: mission.id, max_ms: 30_000 });
    await co.drain();
    assert.equal(rt.store.missions.must(mission.id).status, 'review_ready');
  } finally {
    co.stop();
    cleanup();
  }
});

test('a worker that delivers everything but doubts it is not believed either way: verification decides', async () => {
  const { rt, cleanup } = freshRuntime();
  const co = new Coordinator(rt);
  try {
    const { mission, task } = await readyTask(rt, co, 'doubt');
    const lease = rt.kernel.claim(task.id, task.owner_id, UNATTENDED)!;
    rt.kernel.submitResult(task.id, lease.token, { status: 'blocked', summary: 'Written, but I could not confirm it is what was wanted.', artifacts: [{ key: 'result/summary', kind: 'report', media_type: 'text/plain', content: 'a short written result' }], evidence: [], criteria_claims: [], remaining_uncertainty: ['not confirmed'], questions: [], proposals: [] }, null, { source: 'fixture' });
    assert.equal(rt.store.tasks.must(task.id).status, 'submitted', 'every required output was delivered, so the work is checked instead of parked');
    assert.equal(rt.store.events({ mission_id: mission.id, type: 'worker_doubt_recorded' }).length, 1, 'and the doubt is kept');
    await co.runUntilIdle({ mission_id: mission.id, max_ms: 30_000 });
    await co.drain();
    assert.equal(rt.store.tasks.must(task.id).status, 'accepted');
    assert.equal(rt.store.decisions.where(`"mission_id" = ? AND "kind" = 'blocked_work'`, mission.id).length, 0);
  } finally {
    co.stop();
    cleanup();
  }
});

test('a check that cannot run on a result is not retried forever: the result goes back to its author, inside the repair limit', async () => {
  const { rt, cleanup } = freshRuntime();
  const co = new Coordinator(rt);
  try {
    const cos = new LocalChiefOfStaff(rt);
    const sub = cos.submitMission({ command: 'submitMission', actor: 'chief_of_staff', key: 'uncheckable', data: { title: 'liveness uncheckable', objective: 'produce a short written result' } });
    assert.ok(sub.source !== 'unavailable');
    const mission = sub.mission;
    const scenario = await co.scenario(mission);
    // INJECTED FAULT: a check that throws on every result it is given.
    scenario.inspectors.throws = () => {
      throw new Error('INJECTED: this check cannot read the result');
    };
    const plan = scenario.bootstrapPlan({ mission, defs: co.defs(mission.release_id) });
    plan.tasks[0]!.acceptance_criteria[0]!.check = { runner: 'inspect:throws', target: 'result/summary' };
    materializePlan(rt.kernel, mission, plan, null);

    const state = await co.runUntilIdle({ mission_id: mission.id, max_ms: 60_000 });
    await co.drain();
    assert.equal(state, 'idle', 'the coordinator comes to rest');
    const task = rt.store.tasks.first(`"mission_id" = ? AND "executor" = 'worker'`, mission.id)!;
    assert.equal(task.status, 'failed');
    assert.equal(task.attempt, rt.limits.max_repair_attempts + 1, 'one attempt, then as many repairs as the limit allows');
    const rejections = rt.store.observations.where('"mission_id" = ?', mission.id).filter((o) => o.kind === 'rework');
    assert.equal(rejections.length, task.attempt, 'every attempt was sent back once, the last one for good');
    assert.ok(rejections.every((o) => o.failure_class === 'verification_error'));
    assert.equal(rt.store.missions.must(mission.id).status, 'blocked', 'the mission stops for a person instead of waiting on nothing');
    const d = rt.store.decisions.first(`"mission_id" = ? AND "kind" = 'failure_escalation' AND "status" = 'open'`, mission.id)!;
    assert.match(d.question, /could not be checked \(INJECTED: this check cannot read the result\)/, 'and a person is told why');
  } finally {
    co.stop();
    cleanup();
  }
});

test('a result left mid-check by a coordinator that stopped is checked again by the next one', async () => {
  const { rt, cleanup } = freshRuntime();
  const co = new Coordinator(rt);
  try {
    const { mission, task } = await readyTask(rt, co, 'midcheck');
    const lease = rt.kernel.claim(task.id, task.owner_id, UNATTENDED)!;
    rt.kernel.submitResult(task.id, lease.token, { status: 'completed', summary: 'written', artifacts: [{ key: 'result/summary', kind: 'report', media_type: 'text/plain', content: 'a short written result' }], evidence: [], criteria_claims: [], remaining_uncertainty: [], questions: [], proposals: [] }, null, { source: 'fixture' });
    // The state a coordinator leaves behind when it stops between starting a check and recording its verdict.
    rt.kernel.setStatus(task.id, 'verifying', 'runtime:verifier');
    assert.equal(rt.store.verifications.where('"task_id" = ?', task.id).length, 0);

    assert.equal(await co.runUntilIdle({ mission_id: mission.id, max_ms: 30_000 }), 'idle');
    await co.drain();
    assert.equal(rt.store.tasks.must(task.id).status, 'accepted');
    assert.equal(rt.store.missions.must(mission.id).status, 'review_ready');
  } finally {
    co.stop();
    cleanup();
  }
});

test('a mission in which nothing can run stops and asks a person; one waiting for capacity does not', async () => {
  const { rt, cleanup } = freshRuntime();
  const co = new Coordinator(rt);
  try {
    const { cos, mission, task } = await readyTask(rt, co, 'stalled');
    // The state the kernel leaves when a task has no budget for another attempt: a blocker with a
    // next action for the chief of staff, and until now no decision in anyone's queue.
    rt.kernel.block(rt.store.tasks.must(task.id), 'budget_exhausted', { owner_id: 'chief_of_staff', owner_kind: 'chief_of_staff', action: `Budget exhausted for: ${task.title}`, since: rt.store.clock.iso() });
    assert.equal(await co.runUntilIdle({ mission_id: mission.id, max_ms: 30_000 }), 'idle');
    await co.drain();

    const d = rt.store.decisions.first(`"mission_id" = ? AND "kind" = 'stalled' AND "status" = 'open'`, mission.id)!;
    assert.ok(d, 'the stop reaches a person as a decision');
    assert.equal(d.requires_human, true);
    assert.equal(d.owner_kind, 'chief_of_staff');
    assert.match(d.question, /nothing in it can run/i);
    assert.match(d.question, /budget_exhausted/, 'it says what is in the way');
    assert.deepEqual(d.options.map((o) => o.id), ['resume', 'cancel', 'hold']);
    assert.equal(rt.store.missions.must(mission.id).status, 'blocked', 'and the mission is no longer shown as running');
    const att = cos.attention();
    assert.ok(att.source !== 'unavailable' && att.items.some((i) => i.id === d.id));
    await co.tick(mission.id);
    assert.equal(rt.store.decisions.where(`"mission_id" = ? AND "kind" = 'stalled'`, mission.id).length, 1, 'asked once');

    const res = cos.resolveDecision({ command: 'resolveDecision', actor: 'paul', key: 'stalled-resume', data: { decision_id: d.id, chosen: 'resume', rationale: 'the budget was raised' } });
    assert.ok(res.source !== 'unavailable' && /released/.test(res.effect));
    assert.equal(rt.store.missions.must(mission.id).status, 'active');
    await co.runUntilIdle({ mission_id: mission.id, max_ms: 30_000 });
    await co.drain();
    assert.equal(rt.store.missions.must(mission.id).status, 'review_ready', 'released work runs and the mission completes');
  } finally {
    co.stop();
    cleanup();
  }

  // Waiting for provider capacity is not a stall: it resumes by itself and belongs to the operator.
  const second = freshRuntime();
  const co2 = new Coordinator(second.rt);
  try {
    const { mission, task } = await readyTask(second.rt, co2, 'capacity');
    second.rt.kernel.block(second.rt.store.tasks.must(task.id), 'provider_rate_limited', { owner_id: 'operator', owner_kind: 'operator', action: 'Provider capacity exhausted', since: second.rt.store.clock.iso() });
    // The fixture provider has capacity, so the coordinator releases the task itself and finishes.
    await co2.runUntilIdle({ mission_id: mission.id, max_ms: 30_000 });
    await co2.drain();
    assert.equal(second.rt.store.decisions.where(`"mission_id" = ? AND "kind" = 'stalled'`, mission.id).length, 0);
    assert.equal(second.rt.store.missions.must(mission.id).status, 'review_ready');
  } finally {
    co2.stop();
    second.cleanup();
  }
});

test('the test command given to implementers runs on this Node version', () => {
  const policy = JSON.parse(readFileSync(join(REPO_ROOT, 'definitions/coordination/v1/coordination.json'), 'utf8')) as CoordinationDef;
  const coders = decomposePlan(policy).tasks;
  assert.equal(coders.length, 2);
  for (const t of coders) {
    const m = /as a command on its own: (node --test (test\/([a-z]+)\/\*\.test\.ts))/.exec(String(t.params.guidance));
    assert.ok(m, `${t.ref} is told one exact command`);
    const dir = mkdtempSync(join(tmpdir(), 'swarm2-cmd-'));
    try {
      mkdirSync(join(dir, 'test', m[3]!), { recursive: true });
      writeFileSync(join(dir, 'test', m[3]!, 'sample.test.ts'), `import { test } from 'node:test';\ntest('runs', () => {});\n`);
      // Run as a worker would run it: from a shell, outside this test runner's own context.
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const out = execSync(`${m[1]} 2>&1`, { cwd: dir, encoding: 'utf8', env });
      assert.match(out, /pass 1\b/, 'the command as written finds and runs the tests');
      assert.match(out, /fail 0\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
