import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mission, rig, task } from './helpers.ts';
import { SwarmError } from '../src/lib/util.ts';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SwarmError) return e.code;
    throw e;
  }
  return 'no_error';
}

test('communication is scoped, persisted and measured; large results travel as references', () => {
  const r = rig();
  try {
    const m = mission(r);
    r.comms.subscribe(m.id, 'interface', 'engine-owner');
    r.comms.subscribe(m.id, 'interface', 'report-owner');
    r.comms.subscribe(m.id, 'interface', 'architect');
    const q = r.comms.post({ mission_id: m.id, from_id: 'report-owner', to: 'topic:interface', kind: 'question', body: 'Is staleness reported in minutes or seconds?' });
    assert.deepEqual(q.delivered_to.sort(), ['architect', 'engine-owner'], 'routed to the topic subscribers, not back to the sender, and to nobody else');
    assert.equal(r.comms.openQuestions(m.id).length, 1, 'an unresolved question stays visible');
    r.comms.post({ mission_id: m.id, from_id: 'architect', to: 'report-owner', kind: 'answer', body: 'Minutes; see the pinned contract.', artifact_refs: ['contract/health-record'], in_reply_to: q.id });
    assert.equal(r.comms.openQuestions(m.id).length, 0);
    assert.equal(r.comms.inbox(m.id, 'report-owner').length, 1);
    assert.equal(code(() => r.comms.post({ mission_id: m.id, from_id: 'a', to: 'b', kind: 'notice', body: 'x'.repeat(5000) })), 'message_too_large');
    const cost = r.comms.overhead(m.id);
    assert.equal(cost.messages, 2);
    assert.equal(cost.deliveries, 3);
    assert.ok(cost.bytes > 0 && cost.bytes < 200);
  } finally {
    r.cleanup();
  }
});

test('conflicts go to a named owner; debate is bounded and then escalates', () => {
  const r = rig();
  try {
    const m = mission(r);
    const d = r.comms.openDecision({ mission_id: m.id, kind: 'conflict', question: 'Rename staleness_minutes to staleness_seconds?', owner_id: 'planning-lead', owner_kind: 'agent', max_rounds: 2, options: [
      { id: 'keep', label: 'Keep minutes', evidence_ids: ['evd-1'], consequences: ['No consumer changes'], proposed_by: 'report-owner' },
      { id: 'rename', label: 'Switch to seconds', evidence_ids: ['evd-2'], consequences: ['Both workstreams rerun'], proposed_by: 'engine-owner' },
    ] });
    assert.equal(code(() => r.comms.resolve({ command: 'resolveDecision', actor: 'engine-owner', key: 'k1', data: { decision_id: d.id, chosen: 'rename', rationale: 'I prefer it' } })), 'not_decision_owner', 'a proposer cannot decide in their own favour');
    assert.equal(r.comms.addRound(d.id, null, { owner_id: 'chief_of_staff', owner_kind: 'chief_of_staff' }).status, 'open');
    const escalated = r.comms.addRound(d.id, null, { owner_id: 'chief_of_staff', owner_kind: 'chief_of_staff' });
    assert.equal(escalated.status, 'escalated', 'after the bound the decision escalates instead of continuing');
    assert.equal(escalated.owner_id, 'chief_of_staff');
    assert.equal(escalated.requires_human, true);
    const done = r.comms.resolve({ command: 'resolveDecision', actor: 'chief_of_staff', key: 'k2', data: { decision_id: d.id, chosen: 'keep', rationale: 'No stakeholder asked for seconds.' } });
    assert.equal(done.status, 'resolved');
    assert.equal(r.comms.resolve({ command: 'resolveDecision', actor: 'chief_of_staff', key: 'k2', data: { decision_id: d.id, chosen: 'keep', rationale: 'No stakeholder asked for seconds.' } }).chosen, 'keep', 'a repeated command returns the original decision');

    const next = r.comms.openDecision({ mission_id: m.id, kind: 'conflict', question: 'Revisit the unit?', owner_id: 'planning-lead', owner_kind: 'agent', options: [{ id: 'a', label: 'a', evidence_ids: [], consequences: [], proposed_by: 'x' }], supersedes: d.id });
    assert.equal(r.store.decisions.must(d.id).status, 'superseded', 'current and superseded decisions stay distinguishable');
    assert.equal(r.store.decisions.must(d.id).superseded_by, next.id);
  } finally {
    r.cleanup();
  }
});

test('a pending handoff keeps the original owner until it is accepted', () => {
  const r = rig();
  try {
    const m = mission(r);
    const t = task(r, m, 'a', { owner_id: 'first-owner' });
    const h = r.comms.offerHandoff({ mission_id: m.id, task_id: t.id, from_owner: 'first-owner', to_owner: 'second-owner', artifact_version_id: 'ver-1', acceptance_evidence_ids: ['evd-1'], remaining_uncertainty: ['thresholds are unconfirmed'], note: null });
    assert.equal(r.store.tasks.must(t.id).owner_id, 'first-owner');
    assert.equal(code(() => r.comms.resolveHandoff(h.id, 'someone-else', true)), 'not_handoff_recipient');
    r.comms.resolveHandoff(h.id, 'second-owner', true);
    assert.equal(r.store.tasks.must(t.id).owner_id, 'second-owner');
    assert.equal(code(() => r.comms.resolveHandoff(h.id, 'second-owner', true)), 'handoff_closed');
  } finally {
    r.cleanup();
  }
});

test('outward-facing work is drafted for review and never sent by the system', () => {
  const r = rig();
  try {
    const m = mission(r);
    const d = r.comms.draft({ mission_id: m.id, kind: 'external.communication', audience: 'paul', title: 'Reply to the propulsion team', body: 'Draft text.', context_refs: ['evd-1'] });
    assert.equal(d.status, 'awaiting_review');
    const reviewed = r.comms.reviewDraft({ command: 'reviewDraft', actor: 'paul', key: 'd1', data: { draft_id: d.id, approve: true, note: 'ok' } });
    assert.equal(reviewed.status, 'approved');
    const ev = r.store.events({ type: 'draft_reviewed' })[0]!;
    assert.equal(ev.payload.sent_by_swarm, false);
  } finally {
    r.cleanup();
  }
});
