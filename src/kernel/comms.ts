import type { ActorKind, Command, Decision, DecisionOption, Draft, Handoff, Message, OutwardAction } from '../contracts/types.ts';
import type { Store } from '../store/store.ts';
import { SwarmError, assert, newId } from '../lib/util.ts';

/** Messages larger than this must travel as artifact references. */
export const MAX_MESSAGE_BYTES = 2000;

/**
 * Scoped communication, bounded decisions, two-phase handoffs and outward-facing drafts.
 * Communication is routed to named owners and subscribers and is persisted; it is also measured,
 * so the organization can see what its coordination costs.
 */
export class Comms {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  // ───────── messages ─────────

  subscribe(mission_id: string, topic: string, subscriber_id: string): void {
    this.store.db.run('INSERT OR IGNORE INTO subscriptions (topic, subscriber_id, mission_id) VALUES (?, ?, ?)', topic, subscriber_id, mission_id);
  }

  post(m: { mission_id: string; task_id?: string | null; from_id: string; to: string; kind: Message['kind']; body: string; artifact_refs?: string[]; in_reply_to?: string | null }): Message {
    return this.store.db.tx(() => {
      const bytes = Buffer.byteLength(m.body);
      assert(bytes <= MAX_MESSAGE_BYTES, 'message_too_large', `Message body is ${bytes} bytes; put large results in an artifact and send the reference`, { bytes, limit: MAX_MESSAGE_BYTES });
      const delivered_to = m.to.startsWith('topic:')
        ? this.store.db
            .all<{ subscriber_id: string }>('SELECT subscriber_id FROM subscriptions WHERE topic = ? AND mission_id = ?', m.to.slice(6), m.mission_id)
            .map((r) => r.subscriber_id)
            .filter((s) => s !== m.from_id)
        : [m.to];
      const msg: Message = {
        id: newId('msg'),
        mission_id: m.mission_id,
        task_id: m.task_id ?? null,
        from_id: m.from_id,
        to: m.to,
        kind: m.kind,
        body: m.body,
        artifact_refs: m.artifact_refs ?? [],
        in_reply_to: m.in_reply_to ?? null,
        status: m.kind === 'question' ? 'open' : 'closed',
        delivered_to,
        bytes,
        created_at: this.store.clock.iso(),
      };
      this.store.messages.put(msg);
      if (m.in_reply_to) {
        const q = this.store.messages.get(m.in_reply_to);
        if (q && q.status === 'open') {
          q.status = 'answered';
          this.store.messages.put(q);
        }
      }
      this.store.emit({ type: 'message_routed', mission_id: m.mission_id, task_id: m.task_id ?? null, actor_id: m.from_id, actor_kind: 'agent', payload: { message_id: msg.id, kind: m.kind, to: m.to, delivered_to, bytes, artifact_refs: msg.artifact_refs.length } });
      return msg;
    });
  }

  inbox(mission_id: string, recipient: string): Message[] {
    return this.store.messages.where('"mission_id" = ?', mission_id).filter((m) => m.delivered_to.includes(recipient));
  }

  openQuestions(mission_id: string): Message[] {
    return this.store.messages.where(`"mission_id" = ? AND "kind" = 'question' AND "status" = 'open'`, mission_id);
  }

  overhead(mission_id: string): { messages: number; bytes: number; deliveries: number } {
    const ms = this.store.messages.where('"mission_id" = ?', mission_id);
    return { messages: ms.length, bytes: ms.reduce((a, m) => a + m.bytes, 0), deliveries: ms.reduce((a, m) => a + m.delivered_to.length, 0) };
  }

  // ───────── decisions ─────────

  openDecision(d: { mission_id: string | null; task_id?: string | null; kind: string; question: string; owner_id: string; owner_kind: ActorKind; options: DecisionOption[]; max_rounds?: number; requires_human?: boolean; supersedes?: string | null }): Decision {
    return this.store.db.tx(() => {
      const rec: Decision = {
        id: newId('dec'),
        mission_id: d.mission_id,
        task_id: d.task_id ?? null,
        kind: d.kind,
        question: d.question,
        owner_id: d.owner_id,
        owner_kind: d.owner_kind,
        status: 'open',
        options: d.options,
        chosen: null,
        rationale: null,
        round: 1,
        max_rounds: d.max_rounds ?? 2,
        requires_human: d.requires_human ?? ['human', 'chief_of_staff'].includes(d.owner_kind),
        supersedes: d.supersedes ?? null,
        superseded_by: null,
        created_at: this.store.clock.iso(),
        resolved_at: null,
      };
      this.store.decisions.put(rec);
      if (d.supersedes) {
        const old = this.store.decisions.get(d.supersedes);
        if (old) {
          old.status = 'superseded';
          old.superseded_by = rec.id;
          this.store.decisions.put(old);
        }
      }
      this.store.emit({ type: 'decision_opened', mission_id: d.mission_id, task_id: d.task_id ?? null, actor_id: 'runtime', actor_kind: 'runtime', payload: { decision_id: rec.id, kind: d.kind, owner_id: d.owner_id, owner_kind: d.owner_kind, options: d.options.map((o) => o.id), requires_human: rec.requires_human } });
      return rec;
    });
  }

  /**
   * Another round of argument. Debate is bounded: once `max_rounds` is used up the decision
   * escalates instead of continuing. Contradictory evidence is never settled by majority vote.
   */
  addRound(decision_id: string, option: DecisionOption | null, escalate_to: { owner_id: string; owner_kind: ActorKind }): Decision {
    return this.store.db.tx(() => {
      const d = this.store.decisions.must(decision_id);
      assert(d.status === 'open', 'decision_closed', `Decision ${decision_id} is ${d.status}`);
      if (option) d.options.push(option);
      d.round += 1;
      if (d.round > d.max_rounds) {
        this.store.decisions.put(d);
        return this.escalate(decision_id, escalate_to, 'debate bound reached');
      }
      this.store.decisions.put(d);
      this.store.emit({ type: 'decision_round', mission_id: d.mission_id, task_id: d.task_id, actor_id: option?.proposed_by ?? 'runtime', actor_kind: 'agent', payload: { decision_id, round: d.round, max_rounds: d.max_rounds } });
      return d;
    });
  }

  escalate(decision_id: string, to: { owner_id: string; owner_kind: ActorKind }, why: string): Decision {
    return this.store.db.tx(() => {
      const d = this.store.decisions.must(decision_id);
      assert(['open', 'escalated'].includes(d.status), 'decision_closed', `Decision ${decision_id} is ${d.status}`);
      const from = d.owner_id;
      d.owner_id = to.owner_id;
      d.owner_kind = to.owner_kind;
      d.status = 'escalated';
      d.requires_human = ['human', 'chief_of_staff'].includes(to.owner_kind);
      this.store.decisions.put(d);
      this.store.emit({ type: 'decision_escalated', mission_id: d.mission_id, task_id: d.task_id, actor_id: from, actor_kind: 'agent', payload: { decision_id, from, to: to.owner_id, why } });
      return d;
    });
  }

  /** Only the named decision owner may resolve. */
  resolve(cmd: Command<{ decision_id: string; chosen: string; rationale: string }>): Decision {
    return this.store.idempotent(cmd.key, 'resolveDecision', cmd.data, () => {
      const d = this.store.decisions.must(cmd.data.decision_id);
      assert(['open', 'escalated'].includes(d.status), 'decision_closed', `Decision ${d.id} is ${d.status}`);
      assert(cmd.actor === d.owner_id, 'not_decision_owner', `Decision ${d.id} is owned by ${d.owner_id}, not ${cmd.actor}`, { owner_id: d.owner_id });
      assert(d.options.some((o) => o.id === cmd.data.chosen), 'unknown_option', `Option ${cmd.data.chosen} is not on decision ${d.id}`);
      d.status = 'resolved';
      d.chosen = cmd.data.chosen;
      d.rationale = cmd.data.rationale;
      d.resolved_at = this.store.clock.iso();
      this.store.decisions.put(d);
      this.store.emit({ type: 'decision_resolved', mission_id: d.mission_id, task_id: d.task_id, actor_id: cmd.actor, actor_kind: d.owner_kind, payload: { decision_id: d.id, kind: d.kind, chosen: d.chosen, rationale: d.rationale }, idempotency_key: cmd.key });
      return d;
    }).result;
  }

  // ───────── handoffs ─────────

  /** Offer work to the next owner. Ownership does not move until the offer is accepted. */
  offerHandoff(h: Omit<Handoff, 'id' | 'status' | 'created_at' | 'resolved_at'>): Handoff {
    const rec: Handoff = { ...h, id: newId('hnd'), status: 'offered', created_at: this.store.clock.iso(), resolved_at: null };
    this.store.db.tx(() => {
      this.store.handoffs.put(rec);
      this.store.emit({ type: 'handoff_offered', mission_id: h.mission_id, task_id: h.task_id, actor_id: h.from_owner, actor_kind: 'agent', payload: { handoff_id: rec.id, to: h.to_owner, artifact_version_id: h.artifact_version_id, evidence: h.acceptance_evidence_ids.length, uncertainty: h.remaining_uncertainty } });
    });
    return rec;
  }

  resolveHandoff(handoff_id: string, actor: string, accept: boolean, note: string | null = null): Handoff {
    return this.store.db.tx(() => {
      const h = this.store.handoffs.must(handoff_id);
      assert(h.status === 'offered', 'handoff_closed', `Handoff ${handoff_id} is ${h.status}`);
      assert(actor === h.to_owner, 'not_handoff_recipient', `Handoff ${handoff_id} was offered to ${h.to_owner}, not ${actor}`);
      h.status = accept ? 'accepted' : 'rejected';
      h.resolved_at = this.store.clock.iso();
      h.note = note;
      this.store.handoffs.put(h);
      if (accept) {
        const task = this.store.tasks.get(h.task_id);
        if (task) {
          task.owner_id = h.to_owner;
          task.updated_at = this.store.clock.iso();
          task.revision++;
          this.store.tasks.put(task);
        }
      }
      this.store.emit({ type: accept ? 'handoff_accepted' : 'handoff_rejected', mission_id: h.mission_id, task_id: h.task_id, actor_id: actor, actor_kind: 'agent', payload: { handoff_id, from: h.from_owner, note } });
      return h;
    });
  }

  // ───────── drafts (outward-facing work is never sent by the system) ─────────

  draft(d: { mission_id: string; kind: OutwardAction; audience: string; title: string; body: string; context_refs: string[] }): Draft {
    const rec: Draft = { ...d, id: newId('drf'), status: 'awaiting_review', reviewed_by: null, review_note: null, created_at: this.store.clock.iso(), reviewed_at: null };
    this.store.db.tx(() => {
      this.store.drafts.put(rec);
      this.store.emit({ type: 'draft_prepared', mission_id: d.mission_id, actor_id: 'runtime', actor_kind: 'runtime', payload: { draft_id: rec.id, kind: d.kind, audience: d.audience, context_refs: d.context_refs.length } });
    });
    return rec;
  }

  reviewDraft(cmd: Command<{ draft_id: string; approve: boolean; note: string }>): Draft {
    return this.store.idempotent(cmd.key, 'reviewDraft', cmd.data, () => {
      const d = this.store.drafts.must(cmd.data.draft_id);
      if (d.status !== 'awaiting_review') throw new SwarmError('draft_closed', `Draft ${d.id} is ${d.status}`);
      d.status = cmd.data.approve ? 'approved' : 'rejected';
      d.reviewed_by = cmd.actor;
      d.review_note = cmd.data.note;
      d.reviewed_at = this.store.clock.iso();
      this.store.drafts.put(d);
      // Approval records the human's decision. Sending stays with the chief of staff's own channel.
      this.store.emit({ type: 'draft_reviewed', mission_id: d.mission_id, actor_id: cmd.actor, actor_kind: 'human', payload: { draft_id: d.id, approved: cmd.data.approve, sent_by_swarm: false }, idempotency_key: cmd.key });
      return d;
    }).result;
  }
}
