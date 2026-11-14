import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/coordination/coordinator.ts';
import { validatePlan } from '../src/coordination/plan.ts';
import type { PlanProposal } from '../src/contracts/types.ts';
import { tapFailures } from '../src/workspace/workspaces.ts';
import { freshRuntime, submitScenario } from './e2e.ts';

test('work that exhausts its repairs stops for a person, whose guidance reaches the next attempt', async () => {
  const { rt, cleanup } = freshRuntime();
  const co = new Coordinator(rt);
  try {
    const { cos, mission_id } = submitScenario(rt, 'guided');
    // INJECTED DEFECT on the first three attempts: an unmeasured dataset is shown as zero.
    rt.store.setMeta(`faults:${mission_id}`, [1, 2, 3].map((attempt) => ({ task_key: 'delivery.report.implement', attempt, fault: 'defect:unknown_as_zero' })));
    await co.runUntilIdle({ mission_id, max_ms: 120_000 });
    await co.drain();

    const report = rt.store.tasks.first('"mission_id" = ? AND "key" = ?', mission_id, 'delivery.report.implement')!;
    assert.equal(report.status, 'failed', 'the repair limit is a ceiling for agents');
    assert.equal(rt.store.missions.must(mission_id).status, 'blocked');
    const d = rt.store.decisions.first(`"mission_id" = ? AND "kind" = 'failure_escalation' AND "status" = 'open'`, mission_id)!;
    assert.equal(d.requires_human, true);
    assert.match(d.question, /AC-SLA-QUALITY/, 'the question says which criterion kept failing');
    assert.match(d.question, /this did not hold: "an unmeasured dataset shows unknown and a dash"/, 'what the check requires, stated as a requirement');
    assert.match(d.question, /it got: \| syn-ncr_dispositions \| unknown \| 0 \|/, 'and what the work actually produced');
    assert.deepEqual(d.options.map((o) => o.id), ['retry', 'cancel', 'hold']);
    const att = cos.attention();
    assert.ok(att.source !== 'unavailable' && att.items.some((i) => i.id === d.id));

    const guidance = 'Show an em dash for the staleness of a dataset that was never measured; never a zero.';
    const res = cos.resolveDecision({ command: 'resolveDecision', actor: 'paul', key: 'guided-retry', data: { decision_id: d.id, chosen: 'retry', rationale: guidance } });
    assert.ok(res.source !== 'unavailable' && /sent back/.test(res.effect));
    assert.equal(rt.store.tasks.must(report.id).status, 'ready');
    assert.match(rt.store.getMeta<{ reason: string }>(`task:${report.id}:rework`)!.reason, /em dash/, 'the next worker is given the guidance');
    assert.equal(rt.store.observations.where('"mission_id" = ?', mission_id).filter((o) => o.kind === 'human_correction').length, 1, 'the guidance is kept as a correction from a person');
    assert.ok(rt.store.memories.where(`"kind" = 'correction'`).some((m) => m.statement.includes('em dash')));

    await co.runUntilIdle({ mission_id, max_ms: 120_000 });
    await co.drain();
    assert.equal(rt.store.missions.must(mission_id).status, 'review_ready', 'the fourth attempt carries no defect and the mission completes');
    assert.equal(rt.store.tasks.must(report.id).attempt, 4);
    const sla = rt.store.verifications.where('"mission_id" = ?', mission_id).filter((v) => v.criterion_id === 'AC-SLA-QUALITY').sort((a, b) => a.created_at.localeCompare(b.created_at));
    assert.deepEqual(sla.map((v) => v.verdict), ['fail', 'fail', 'fail', 'pass']);
    // A second failure after a person's one extra attempt would stop again: the ceiling was lifted once, not removed.
    assert.equal(rt.store.tasks.must(report.id).repairs <= rt.limits.max_repair_attempts, true);
  } finally {
    co.stop();
    cleanup();
  }
});

test('a failing check reports what it expected and what it got, not its code', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: AC-X: shows unknown',
    'not ok 1 - AC-X: shows unknown',
    '  ---',
    '  duration_ms: 1.2',
    "  location: '/x/acceptance.test.ts:50:1'",
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    an unmeasured dataset shows unknown and a dash',
    '    ',
    '    The input did not match the regular expression /\\| unknown \\| — \\|/. Input:',
    "  code: 'ERR_ASSERTION'",
    '  expected: /\\| unknown \\| — \\|/',
    "  actual: '| syn-ncr_dispositions | unknown | n/a |'",
    '  stack: |-',
    '    TestContext.<anonymous> (file:///x/acceptance.test.ts:55:10)',
    '  ...',
    'ok 2 - AC-Y: fine',
  ].join('\n');
  const f = tapFailures(tap);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.name, 'AC-X: shows unknown');
  assert.match(f[0]!.message, /the check expected: \/\\\| unknown/);
  assert.match(f[0]!.message, /it got: \| syn-ncr_dispositions \| unknown \| n\/a \|/);
  assert.doesNotMatch(f[0]!.message, /acceptance\.test\.ts/, 'no stack and no file locations');
});

test('a malformed plan proposal is refused with a reason instead of breaking validation', () => {
  const { rt, cleanup } = freshRuntime();
  try {
    const { mission_id } = submitScenario(rt, 'shape');
    const m = rt.store.missions.must(mission_id);
    for (const bad of [{}, { steps: ['do the thing'] }, { topology: 'parallel', anchor: 'mission', swarms: 'none', tasks: [], interface_agreements: [], extra_dependencies: [] }, null, 'a plan']) {
      const errors = validatePlan(rt.kernel, m, bad as unknown as PlanProposal, null);
      assert.equal(errors.length, 1);
      assert.match(errors[0]!, /malformed/);
    }
    const partial = { topology: 'parallel', anchor: 'mission', swarms: [{ ref: 's' }], tasks: [{ ref: 't' }], interface_agreements: [], extra_dependencies: [] };
    assert.match(validatePlan(rt.kernel, m, partial as unknown as PlanProposal, null)[0]!, /swarm 0 lacks a ref or an archetype|task 0 lacks/);
  } finally {
    cleanup();
  }
});
