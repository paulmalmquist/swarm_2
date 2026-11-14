import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlanProposal } from '../src/contracts/types.ts';
import { Coordinator } from '../src/coordination/coordinator.ts';
import { materializePlan, validatePlan } from '../src/coordination/plan.ts';
import { LocalChiefOfStaff } from '../src/cos/port.ts';
import { freshRuntime, submitScenario } from './e2e.ts';

type PT = PlanProposal['tasks'][number];
const base = (t: Partial<PT> & Pick<PT, 'ref' | 'swarm_ref' | 'title'>): PT => ({ objective: t.title, executor: 'worker', role: 'specialist', depends_on: [], verifies: [], input_keys: [], outputs: [], params: {}, acceptance_criteria: [], verification: { method: 'executable', independent: true }, write_scope: [], budget_share: 0.2, budget_class: 'delivery', competing_group: null, risk_tier: 'low', ...t });
const swarm = (ref: string, archetype: PlanProposal['swarms'][number]['archetype'], over: Partial<PlanProposal['swarms'][number]> = {}): PlanProposal['swarms'][number] => ({ ref, archetype, parent_ref: null, purpose: `purpose of ${ref}`, deliverable: `deliverable of ${ref}`, stopping_condition: 'accepted or out of budget', budget_share: 0.3, temporary: false, depends_on: [], ...over });
const nonempty = (id: string, key: string) => ({ criterion_id: id, description: `a result is produced under ${key}`, verification_kind: 'inspection' as const, required_evidence_types: ['inspection'], mandatory: true, stakeholder: null, check: { runner: 'inspect:nonempty', target: key } });

function newMission(rt: ReturnType<typeof freshRuntime>['rt'], key: string) {
  const cos = new LocalChiefOfStaff(rt);
  const r = cos.submitMission({ command: 'submitMission', actor: 'chief_of_staff', key, data: { title: `pattern ${key}`, objective: 'exercise an execution pattern' } });
  assert.ok(r.source !== 'unavailable');
  return r.mission;
}

test('pattern: one agent for straightforward work', async () => {
  const { rt, cleanup } = freshRuntime();
  const co = new Coordinator(rt);
  try {
    const m = newMission(rt, 'single');
    assert.equal(await co.runUntilIdle({ max_ms: 30_000 }), 'idle');
    await co.drain();
    const tasks = rt.store.tasks.where('"mission_id" = ?', m.id);
    assert.equal(tasks.filter((t) => t.executor === 'worker').length, 1, 'the smallest organization that fits: one agent');
    assert.equal(rt.store.missions.must(m.id).status, 'review_ready');
  } finally {
    co.stop();
    cleanup();
  }
});

test('pattern: parallel specialists, then a synthesis', async () => {
  const { rt, cleanup } = freshRuntime();
  const co = new Coordinator(rt);
  try {
    const m = newMission(rt, 'parallel');
    const plan: PlanProposal = {
      topology: 'parallel', anchor: 'mission', rationale: 'three independent investigations', interface_agreements: [], extra_dependencies: [],
      swarms: [swarm('investigate', 'discovery', { budget_share: 0.5 })],
      tasks: [
        ...['a', 'b', 'c'].map((x) => base({ ref: `investigate.${x}`, swarm_ref: 'investigate', title: `Investigate ${x}`, outputs: [{ key: `finding/${x}`, kind: 'report', description: x }], acceptance_criteria: [nonempty(`F-${x}`, `finding/${x}`)], params: { fixture: { content: `finding ${x}` } } })),
        base({ ref: 'investigate.synthesis', swarm_ref: 'investigate', title: 'Synthesize the findings', depends_on: ['investigate.a', 'investigate.b', 'investigate.c'], input_keys: ['finding/a', 'finding/b', 'finding/c'], outputs: [{ key: 'finding/summary', kind: 'report', description: 'summary' }], acceptance_criteria: [nonempty('F-sum', 'finding/summary')] }),
      ],
    };
    materializePlan(rt.kernel, m, plan, null);
    assert.equal(await co.runUntilIdle({ max_ms: 30_000 }), 'idle');
    await co.drain();
    const leased = rt.store.events({ mission_id: m.id, type: 'task_leased' });
    const submitted = rt.store.events({ mission_id: m.id, type: 'result_submitted' });
    const firstSubmit = Math.min(...['a', 'b', 'c'].map((x) => submitted.find((e) => e.payload.key === `investigate.${x}`)!.seq));
    assert.ok(['a', 'b', 'c'].every((x) => leased.find((e) => e.payload.key === `investigate.${x}`)!.seq < firstSubmit), 'all three specialists were working before the first finished');
    const synth = leased.find((e) => e.payload.key === 'investigate.synthesis')!;
    assert.equal((synth.payload.inputs as unknown[]).length, 3, 'the synthesis pinned all three findings');
    assert.equal(rt.store.missions.must(m.id).status, 'review_ready');
  } finally {
    co.stop();
    cleanup();
  }
});

test('pattern: competing approaches, selected on verified evidence', async () => {
  const { rt, cleanup } = freshRuntime();
  const co = new Coordinator(rt);
  try {
    const m = newMission(rt, 'competing');
    const option = (x: string, quality: number): PT => base({ ref: `design.${x}`, swarm_ref: 'design', title: `Approach ${x}`, competing_group: 'design', outputs: [{ key: `design/${x}`, kind: 'plan', description: x }], params: { fixture: { quality } }, acceptance_criteria: [{ criterion_id: 'Q', description: 'the design reaches quality 3', verification_kind: 'inspection', required_evidence_types: ['inspection'], mandatory: true, stakeholder: null, check: { runner: 'inspect:quality_at_least', target: `design/${x}:3` } }] });
    const plan: PlanProposal = {
      topology: 'competing', anchor: 'mission', rationale: 'two candidate designs; choose on evidence', interface_agreements: [], extra_dependencies: [],
      swarms: [swarm('design', 'planning', { budget_share: 0.5 })],
      tasks: [option('a', 2), option('b', 5), base({ ref: 'design.select', swarm_ref: 'design', title: 'Select a design', executor: 'runtime:select', role: 'architect', verifies: ['design.a', 'design.b'], verification: { method: 'none', independent: false } })],
    };
    assert.deepEqual(validatePlan(rt.kernel, m, plan, null), []);
    materializePlan(rt.kernel, m, plan, null);
    assert.equal(await co.runUntilIdle({ max_ms: 30_000 }), 'idle');
    await co.drain();
    const by = Object.fromEntries(rt.store.tasks.where('"mission_id" = ?', m.id).map((t) => [t.key, t.status]));
    assert.equal(by['design.b'], 'accepted');
    assert.equal(by['design.a'], 'not_selected');
    const d = rt.store.decisions.where(`"mission_id" = ? AND "kind" = 'selection'`, m.id)[0]!;
    assert.equal(d.status, 'resolved');
    assert.equal(d.chosen, 'design.b');
    assert.ok(d.options.every((o) => o.evidence_ids.length > 0), 'each option carries its evidence');
    assert.ok(rt.kernel.currentVersion(m.id, 'design/a'), 'the losing approach is preserved');
    assert.equal(rt.store.missions.must(m.id).status, 'review_ready');
  } finally {
    co.stop();
    cleanup();
  }
});

test('pattern: a temporary specialist team is bounded and disbands', async () => {
  const { rt, cleanup } = freshRuntime();
  const co = new Coordinator(rt);
  try {
    const m = newMission(rt, 'temporary');
    const plan: PlanProposal = {
      topology: 'temporary_team', anchor: 'mission', rationale: 'an unfamiliar problem needs a short-lived specialist team', interface_agreements: [], extra_dependencies: [],
      swarms: [swarm('specialists', 'discovery', { temporary: true, budget_share: 0.2 })],
      tasks: [base({ ref: 'specialists.probe', swarm_ref: 'specialists', title: 'Probe the unfamiliar system', outputs: [{ key: 'probe/notes', kind: 'report', description: 'notes' }], acceptance_criteria: [nonempty('P', 'probe/notes')] })],
    };
    assert.match(validatePlan(rt.kernel, m, { ...plan, swarms: [{ ...plan.swarms[0]!, stopping_condition: '' }] }, null).join(' '), /stopping condition/, 'a team without a stopping condition is refused');
    materializePlan(rt.kernel, m, plan, null);
    await co.runUntilIdle({ max_ms: 30_000 });
    await co.drain();
    const s = rt.store.swarms.where('"mission_id" = ?', m.id)[0]!;
    assert.equal(s.status, 'disbanded');
    assert.equal(rt.store.accounts.must(s.budget_account_id).status, 'closed', 'its unspent budget went back to the mission');
  } finally {
    co.stop();
    cleanup();
  }
});

test('plans are proposals: the runtime refuses ones that are unsound or exceed authority', () => {
  const { rt, cleanup } = freshRuntime();
  try {
    const m = newMission(rt, 'refused');
    const ok: PlanProposal = { topology: 'parallel', anchor: 'mission', rationale: 'r', interface_agreements: [], extra_dependencies: [], swarms: [swarm('s', 'delivery', { budget_share: 0.6 })], tasks: [base({ ref: 's.a', swarm_ref: 's', title: 'a', depends_on: ['s.b'], outputs: [{ key: 'code/a', kind: 'code', description: 'a' }], write_scope: ['src/**'], acceptance_criteria: [nonempty('A', 'x')] }), base({ ref: 's.b', swarm_ref: 's', title: 'b', depends_on: ['s.a'], outputs: [{ key: 'code/b', kind: 'code', description: 'b' }], write_scope: ['src/**'], acceptance_criteria: [nonempty('B', 'x')] })] };
    const errors = validatePlan(rt.kernel, m, ok, null).join(' | ');
    assert.match(errors, /dependency cycle/);
    assert.match(errors, /share write scope/);
    assert.match(validatePlan(rt.kernel, m, { ...ok, tasks: [base({ ref: 's.a', swarm_ref: 's', title: 'a' })] }, null).join(' '), /no acceptance criteria/);
    assert.match(validatePlan(rt.kernel, m, { ...ok, tasks: [], swarms: [swarm('s', 'delivery', { budget_share: 0.7 }), swarm('t', 'delivery', { budget_share: 0.6 })] }, null).join(' '), /more than the parent holds/);
  } finally {
    cleanup();
  }
});

test('reuse across missions: an identical verified investigation is not repeated', async () => {
  const { rt, cleanup } = freshRuntime();
  const co = new Coordinator(rt);
  try {
    const first = submitScenario(rt, 'reuse-1');
    await co.runUntilIdle({ mission_id: first.mission_id, max_ms: 90_000 });
    await co.drain();
    assert.equal(rt.store.missions.must(first.mission_id).status, 'review_ready');

    const cos = new LocalChiefOfStaff(rt);
    const ids = rt.store.missions.must(first.mission_id).request_ids;
    const second = cos.submitMission({ command: 'submitMission', actor: 'chief_of_staff', key: 'reuse-2', data: { title: 'The same requests, asked again', objective: 'Give every team one policy-driven way to see which datasets are stale, drifting or unmeasured, and who owns them.', request_ids: ids, scenario: 'shared-capability' } });
    assert.ok(second.source !== 'unavailable');
    await co.runUntilIdle({ mission_id: second.mission.id, max_ms: 90_000 });
    await co.drain();
    const reused = rt.store.events({ mission_id: second.mission.id, type: 'result_reused_across_missions' });
    assert.equal(reused.length, 1);
    assert.equal(reused[0]!.payload.key, 'discovery.analyze');
    const t = rt.store.tasks.first('"mission_id" = ? AND "key" = ?', second.mission.id, 'discovery.analyze')!;
    assert.equal(rt.kernel.attemptFor(t.id, 1)!.provider, 'reuse', 'no worker ran for the reused investigation');
    assert.equal(t.status, 'accepted');
    assert.equal(rt.store.needs.where('"mission_id" = ?', second.mission.id).length, 4, 'each stakeholder need is still recorded for the new mission');
    assert.equal(rt.store.missions.must(second.mission.id).status, 'review_ready');
  } finally {
    co.stop();
    cleanup();
  }
});
