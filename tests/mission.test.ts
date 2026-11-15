import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/coordination/coordinator.ts';
import { renderPacket } from '../src/coordination/steps.ts';
import { LocalChiefOfStaff } from '../src/cos/port.ts';
import { freshRuntime, scenarioRequests, submitScenario } from './e2e.ts';

test('a mission runs from intake to an independently verified, reviewable result', async () => {
  const { rt, cleanup } = freshRuntime();
  const logs: string[] = [];
  const co = new Coordinator(rt, { log: (m) => logs.push(m) });
  try {
    const cos = new LocalChiefOfStaff(rt);
    const ing = cos.ingestRequests({ command: 'ingestRequests', actor: 'chief_of_staff', key: 'ing-1', data: { requests: scenarioRequests() } });
    assert.ok(ing.source !== 'unavailable');
    assert.equal(ing.received, 5);
    assert.equal(ing.clusters.length, 1, 'one overlap cluster');
    assert.deepEqual(ing.clusters[0]!.request_ids, ['syn-req-001', 'syn-req-002', 'syn-req-003', 'syn-req-004'], 'the unrelated request is not merged in');

    const { mission_id } = submitScenario(rt, 'again'); // re-ingesting the same requests is a no-op
    assert.equal(rt.store.requests.count(), 5);

    const state = await co.runUntilIdle({ max_ms: 120_000 });
    await co.drain();
    const m = rt.store.missions.must(mission_id);
    if (m.status !== 'review_ready' || process.env.SWARM2_DEBUG) console.log(logs.join('\n'), '\n', rt.store.tasks.where('"mission_id" = ?', mission_id).map((t) => `${t.key}:${t.status}${t.blocked_reason ? `(${t.blocked_reason})` : ''}`).join(' '));
    assert.equal(state, 'idle');
    assert.equal(m.status, 'review_ready');

    const tasks = rt.store.tasks.where('"mission_id" = ?', mission_id);
    assert.ok(tasks.every((t) => t.status === 'accepted'), 'every task is accepted');
    assert.equal(Math.max(...tasks.map((t) => t.depth)), 3, 'three delegated layers were used');
    const archetypes = new Set(rt.store.swarms.where('"mission_id" = ?', mission_id).map((s) => s.archetype));
    assert.ok(['discovery', 'planning', 'delivery', 'verification', 'reliability'].every((a) => archetypes.has(a as never)), 'five swarm capabilities took part');

    // two workstreams really ran at the same time
    const leased = rt.store.events({ mission_id, type: 'task_leased' });
    const submitted = rt.store.events({ mission_id, type: 'result_submitted' });
    const span = (key: string) => ({ start: leased.find((e) => e.payload.key === key)!.seq, end: submitted.find((e) => e.payload.key === key)!.seq });
    const engine = span('delivery.engine.implement');
    const report = span('delivery.report.implement');
    assert.ok(engine.start < report.end && report.start < engine.end, 'the two workstreams overlapped in time');

    // the integrated result was verified independently, against tests delivery never saw
    const integrate = tasks.find((t) => t.key === 'delivery.integrate')!;
    const vs = rt.store.verifications.where('"task_id" = ? AND "generation" = ?', integrate.id, integrate.generation);
    assert.equal(vs.length, 5);
    assert.ok(vs.every((v) => v.verdict === 'pass' && v.independent));
    assert.ok(rt.store.needs.where('"mission_id" = ?', mission_id).every((n) => n.status === 'satisfied'), 'each stakeholder need is shown satisfied');

    // review packet and the decision it asks for
    const ev = cos.retrieveEvidence(mission_id);
    assert.ok(ev.source !== 'unavailable');
    assert.equal(ev.packet!.acceptance.filter((a) => a.verdict === 'pass').length, 5);
    assert.ok(ev.packet!.exact_changes!.files.some((f) => f.path === 'src/engine/evaluate.ts'));
    assert.ok(ev.chain_ok);
    // The packet says whether its usage figures are complete, and says so in words when they are not.
    assert.equal(ev.packet!.resource_use.usage_completeness, 'complete');
    assert.equal(ev.packet!.resource_use.unreported_attempts, 0);
    assert.doesNotMatch(ev.packet_markdown!, /lower bounds/);
    assert.match(renderPacket({ ...ev.packet!, resource_use: { ...ev.packet!.resource_use, unreported_attempts: 2 } }), /- 2 model attempt\(s\) ended without reporting what they used\. Tokens and cost above are lower bounds\./);
    const attention = cos.attention();
    assert.ok(attention.source !== 'unavailable');
    assert.deepEqual(attention.items.map((i) => i.kind).sort(), ['decision', 'draft']);

    const decision = attention.items.find((i) => i.kind === 'decision')!;
    const done = cos.resolveDecision({ command: 'resolveDecision', actor: 'paul', key: 'approve-1', data: { decision_id: decision.id, chosen: 'approve', rationale: 'Evidence is sufficient.' } });
    assert.ok(done.source !== 'unavailable');
    assert.equal(rt.store.missions.must(mission_id).status, 'completed');
    assert.equal(rt.store.drafts.where('"mission_id" = ?', mission_id)[0]!.status, 'approved');
    assert.equal(rt.kernel.budget.reconcile(m.budget_account_id).ok, true);
  } finally {
    co.stop();
    cleanup();
  }
});
