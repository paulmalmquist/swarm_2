import type { ActorKind, AuthorityEnvelope, Command, Decision, Draft, Envelope, IntakeRequest, Mission, NextAction, ResourceAmounts, ReviewPacket, SourceLabel } from '../contracts/types.ts';
import { devAuthority, devBudget } from '../config.ts';
import type { Cluster } from '../kernel/intake.ts';
import type { Runtime } from '../runtime.ts';
import { SwarmError, newId } from '../lib/util.ts';

/**
 * The chief of staff's interface to swarm_2.
 *
 * The chief of staff owns priorities, human interaction and commitments. This port is everything
 * it needs from the execution layer: submit an authorized mission, change its priority, inspect
 * progress, receive the decisions that need a person, and retrieve completed evidence.
 * Every mutation is a command envelope with an idempotency key; every read is a provenance envelope.
 */
export interface ChiefOfStaffPort {
  readonly adapter: string;
  ingestRequests(cmd: Command<{ requests: RawRequest[] }>): Envelope<{ received: number; duplicates: number; clusters: Cluster[] }>;
  proposals(): Envelope<{ proposals: MissionProposal[] }>;
  submitMission(cmd: Command<SubmitMission>): Envelope<{ mission: Mission }>;
  changePriority(cmd: Command<{ mission_id: string; priority: number }>): Envelope<{ mission: Mission }>;
  cancelMission(cmd: Command<{ mission_id: string; reason: string }>): Envelope<{ mission: Mission; cancelled_tasks: string[]; pids_to_stop: number[] }>;
  inspectProgress(mission_id?: string): Envelope<{ missions: ProgressSnapshot[] }>;
  attention(): Envelope<{ items: AttentionItem[] }>;
  resolveDecision(cmd: Command<{ decision_id: string; chosen: string; rationale: string }>): Envelope<{ decision: Decision; effect: string }>;
  reviewDraft(cmd: Command<{ draft_id: string; approve: boolean; note: string }>): Envelope<{ draft: Draft }>;
  retrieveEvidence(mission_id: string): Envelope<{ packet: ReviewPacket | null; packet_markdown: string | null; event_count: number; chain_ok: boolean }>;
  recordCorrection(cmd: Command<{ mission_id: string; task_key: string | null; correction: string; failure_class: string }>): Envelope<{ observation_id: string; memory_id: string }>;
}

export interface RawRequest {
  id: string;
  source: string;
  stakeholder: string;
  team: string;
  text: string;
  received_at: string;
}

export interface SubmitMission {
  title: string;
  objective: string;
  priority?: number;
  request_ids?: string[];
  scenario?: string | null;
  provider_mode?: 'fixture' | 'live';
  data_class?: 'synthetic' | 'real';
  budget?: ResourceAmounts;
  authorization?: AuthorityEnvelope;
  accountable_human?: string;
  /** Pin a specific release. Normally omitted: the active release (or a managed canary) is used. */
  release_id?: string;
}

export interface MissionProposal {
  cluster_id: string;
  title: string;
  request_ids: string[];
  stakeholders: string[];
  shared_tags: string[];
  basis: string;
}

export interface ProgressSnapshot {
  mission: Pick<Mission, 'id' | 'title' | 'status' | 'priority' | 'release_id' | 'provider_mode' | 'data_class' | 'created_at'>;
  tasks: { total: number; by_status: Record<string, number> };
  /** Whose action or decision is needed next, per unfinished task. */
  next_actions: (NextAction & { task_key: string; task_title: string; status: string })[];
  blockers: { task_key: string; reason: string | null; owner_id: string | null }[];
  spent: ResourceAmounts;
  budget: ResourceAmounts;
  open_decisions: number;
}

export interface AttentionItem {
  kind: 'decision' | 'draft';
  id: string;
  mission_id: string | null;
  title: string;
  /** Cold-read lines: what happened, and what the action changes. */
  what: string;
  action: string;
  options: { id: string; label: string; consequences: string[] }[];
  owner_id: string;
  owner_kind: ActorKind;
  created_at: string;
}

/**
 * LOCAL IMPLEMENTATION of the chief-of-staff port, operating directly on the runtime.
 * The real chief of staff (Paul OS, with Attention as its sole mutation surface) is not reachable
 * from this environment; an adapter for it implements this same interface.
 */
export class LocalChiefOfStaff implements ChiefOfStaffPort {
  readonly adapter = 'local';
  private rt: Runtime;
  /**
   * Resolves which release a new mission is pinned to: the active release, or a managed canary.
   * `onPinned` lets the release gate record which missions a canary took.
   */
  releaseFor: (m: SubmitMission) => { release_id: string; canary_id: string | null };
  onPinned: ((canary_id: string, mission_id: string) => void) | null = null;

  constructor(rt: Runtime, releaseFor?: (m: SubmitMission) => { release_id: string; canary_id: string | null }) {
    this.rt = rt;
    this.releaseFor = releaseFor ?? (() => ({ release_id: rt.registry.active(), canary_id: null }));
  }

  private env<T>(data: T, source: Exclude<SourceLabel, 'unavailable'> = 'fixture'): Envelope<T> {
    return { source, generated_at: this.rt.store.clock.iso(), ...data };
  }

  private sourceOf(mission_id: string | null): Exclude<SourceLabel, 'unavailable'> {
    return this.rt.kernel.sourceOf(mission_id) === 'live' ? 'live' : 'fixture';
  }

  ingestRequests(cmd: Command<{ requests: RawRequest[] }>): Envelope<{ received: number; duplicates: number; clusters: Cluster[] }> {
    let received = 0;
    let duplicates = 0;
    for (const r of cmd.data.requests) {
      const res = this.rt.intake.ingest({ ...r, data_class: r.id.startsWith('syn-') ? 'synthetic' : 'real' });
      if (res.duplicate) duplicates++;
      else received++;
    }
    return this.env({ received, duplicates, clusters: this.rt.intake.cluster() });
  }

  proposals(): Envelope<{ proposals: MissionProposal[] }> {
    const reqs = this.rt.store.requests.where('"mission_id" IS NULL AND "cluster_id" IS NOT NULL');
    const byCluster = new Map<string, IntakeRequest[]>();
    for (const r of reqs) byCluster.set(r.cluster_id!, [...(byCluster.get(r.cluster_id!) ?? []), r]);
    const proposals = [...byCluster.entries()].map(([cluster_id, members]) => {
      const tags = members[0]!.signature.capability_tags.filter((t) => members.filter((m) => m.signature.capability_tags.includes(t)).length >= Math.ceil(members.length / 2));
      return {
        cluster_id,
        title: `Shared need across ${members.length} requests: ${tags.join(', ') || 'overlapping scope'}`,
        request_ids: members.map((m) => m.id).sort(),
        stakeholders: members.map((m) => `${m.stakeholder} (${m.team})`),
        shared_tags: tags,
        basis: 'Lexical overlap nominated these requests. Consolidating them is a decision for the chief of staff.',
      };
    });
    return this.env({ proposals });
  }

  submitMission(cmd: Command<SubmitMission>): Envelope<{ mission: Mission }> {
    const d = cmd.data;
    const { kernel, store } = this.rt;
    const provider_mode = d.provider_mode ?? 'fixture';
    const pin = d.release_id ? { release_id: d.release_id, canary_id: null } : this.releaseFor({ ...d, provider_mode });
    const mission = store.db.tx(() => {
      const before = store.missions.count();
      const m = kernel.createMission({
        command: 'createMission',
        actor: cmd.actor,
        key: cmd.key,
        data: {
          title: d.title,
          objective: d.objective,
          priority: d.priority ?? 5,
          requested_by: cmd.actor,
          accountable_human: d.accountable_human ?? 'paul',
          authorization: d.authorization ?? devAuthority(),
          budget: d.budget ?? devBudget(),
          data_class: d.data_class ?? 'synthetic',
          provider_mode,
          scenario: d.scenario ?? null,
          request_ids: d.request_ids ?? [],
          release_id: pin.release_id,
        },
      });
      if (store.missions.count() === before) return m; // replayed command: nothing more to do
      if (pin.canary_id) {
        this.onPinned?.(pin.canary_id, m.id);
        store.emit({ type: 'mission_pinned_to_canary', mission_id: m.id, actor_id: 'release-gate', actor_kind: 'gate', payload: { canary_id: pin.canary_id, release_id: pin.release_id } });
      }
      const requests = (d.request_ids ?? []).map((id) => store.requests.get(id)).filter((r): r is IntakeRequest => Boolean(r));
      for (const r of requests) store.requests.put({ ...r, mission_id: m.id });
      if (requests.length) {
        kernel.publishVersion({
          mission_id: m.id,
          key: 'intake/requests',
          kind: 'report',
          media_type: 'application/json',
          content: JSON.stringify({ requests: requests.map((r) => ({ id: r.id, source: r.source, stakeholder: r.stakeholder, team: r.team, text: r.text, received_at: r.received_at })) }, null, 2),
          produced_by_task_id: null,
          produced_by_attempt: null,
          inputs: [],
          release_id: m.release_id,
          source: provider_mode === 'live' ? 'live' : 'fixture',
        });
      }
      return m;
    });
    return this.env({ mission }, provider_mode === 'live' ? 'live' : 'fixture');
  }

  changePriority(cmd: Command<{ mission_id: string; priority: number }>): Envelope<{ mission: Mission }> {
    return this.env({ mission: this.rt.kernel.changePriority(cmd) }, this.sourceOf(cmd.data.mission_id));
  }

  cancelMission(cmd: Command<{ mission_id: string; reason: string }>): Envelope<{ mission: Mission; cancelled_tasks: string[]; pids_to_stop: number[] }> {
    const r = this.rt.kernel.cancelMission(cmd);
    return this.env({ mission: r.mission, cancelled_tasks: r.cancelled, pids_to_stop: r.pids }, this.sourceOf(cmd.data.mission_id));
  }

  inspectProgress(mission_id?: string): Envelope<{ missions: ProgressSnapshot[] }> {
    const { store, kernel } = this.rt;
    const missions = (mission_id ? [store.missions.must(mission_id)] : store.missions.where('1=1')).sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
    const snapshots = missions.map((m): ProgressSnapshot => {
      const tasks = store.tasks.where('"mission_id" = ?', m.id);
      const by_status: Record<string, number> = {};
      for (const t of tasks) by_status[t.status] = (by_status[t.status] ?? 0) + 1;
      return {
        mission: { id: m.id, title: m.title, status: m.status, priority: m.priority, release_id: m.release_id, provider_mode: m.provider_mode, data_class: m.data_class, created_at: m.created_at },
        tasks: { total: tasks.length, by_status },
        next_actions: tasks.filter((t) => t.next_action).map((t) => ({ ...t.next_action!, task_key: t.key, task_title: t.title, status: t.status })),
        blockers: tasks.filter((t) => t.status === 'blocked' || t.status === 'failed').map((t) => ({ task_key: t.key, reason: t.blocked_reason ?? t.status, owner_id: t.next_action?.owner_id ?? null })),
        spent: kernel.budget.spent(m.budget_account_id),
        budget: store.accounts.must(m.budget_account_id).limit,
        open_decisions: store.decisions.where(`"mission_id" = ? AND "status" IN ('open', 'escalated')`, m.id).length,
      };
    });
    return this.env({ missions: snapshots });
  }

  /** What needs a person: decisions owned by the chief of staff or a human, and drafts awaiting review. */
  attention(): Envelope<{ items: AttentionItem[] }> {
    const { store } = this.rt;
    const items: AttentionItem[] = [];
    for (const d of store.decisions.where(`"status" IN ('open', 'escalated') AND "requires_human" = 1`)) {
      const m = d.mission_id ? store.missions.get(d.mission_id) : undefined;
      items.push({
        kind: 'decision',
        id: d.id,
        mission_id: d.mission_id,
        title: d.question,
        what: m ? `Mission "${m.title}" needs a decision that the organization may not make itself.` : 'The organization needs a decision that it may not make itself.',
        action: 'Choose one option. Your choice is recorded with your rationale and applied; nothing is sent or merged by the system.',
        options: d.options.map((o) => ({ id: o.id, label: o.label, consequences: o.consequences })),
        owner_id: d.owner_id,
        owner_kind: d.owner_kind,
        created_at: d.created_at,
      });
    }
    for (const dr of store.drafts.where(`"status" = 'awaiting_review'`)) {
      items.push({
        kind: 'draft',
        id: dr.id,
        mission_id: dr.mission_id,
        title: dr.title,
        what: `A ${dr.kind} draft for ${dr.audience} is ready in final form with its supporting context.`,
        action: 'Approve or reject the draft. Approval records your decision; sending stays with you.',
        options: [
          { id: 'approve', label: 'Approve', consequences: ['Marked approved; not sent by the system'] },
          { id: 'reject', label: 'Reject', consequences: ['Marked rejected; kept for the record'] },
        ],
        owner_id: dr.audience,
        owner_kind: 'human',
        created_at: dr.created_at,
      });
    }
    return this.env({ items: items.sort((a, b) => a.created_at.localeCompare(b.created_at)) });
  }

  resolveDecision(cmd: Command<{ decision_id: string; chosen: string; rationale: string }>): Envelope<{ decision: Decision; effect: string }> {
    const { store, kernel, comms } = this.rt;
    const before = store.decisions.must(cmd.data.decision_id);
    if (!['chief_of_staff', 'human'].includes(before.owner_kind)) throw new SwarmError('not_decision_owner', `Decision ${before.id} is not the chief of staff's to make`);
    const wasOpen = ['open', 'escalated'].includes(before.status);
    const decision = comms.resolve({ ...cmd, actor: before.owner_id });
    let effect = 'recorded';
    if (wasOpen && decision.mission_id) {
      const m = store.missions.must(decision.mission_id);
      const review = store.getMeta<{ decision_id: string; draft_id: string }>(`mission:${m.id}:review`);
      if (decision.kind === 'outward_action' && review?.decision_id === decision.id) {
        if (decision.chosen === 'approve') {
          comms.reviewDraft({ command: 'reviewDraft', actor: cmd.actor, key: `${cmd.key}:draft`, data: { draft_id: review.draft_id, approve: true, note: cmd.data.rationale } });
          kernel.setMissionStatus(m.id, 'completed', cmd.actor, { decision_id: decision.id });
          kernel.budget.close(m.budget_account_id);
          effect = 'draft approved; mission completed; the merge itself stays with the existing protected path';
        } else if (decision.chosen === 'reject') {
          comms.reviewDraft({ command: 'reviewDraft', actor: cmd.actor, key: `${cmd.key}:draft`, data: { draft_id: review.draft_id, approve: false, note: cmd.data.rationale } });
          kernel.cancelMission({ command: 'cancelMission', actor: cmd.actor, key: `${cmd.key}:cancel`, data: { mission_id: m.id, reason: `rejected at review: ${cmd.data.rationale}` } });
          effect = 'draft rejected; mission closed; artifacts kept';
        } else {
          this.recordCorrection({ command: 'recordCorrection', actor: cmd.actor, key: `${cmd.key}:correction`, data: { mission_id: m.id, task_key: null, correction: cmd.data.rationale, failure_class: 'review_correction' } });
          kernel.setMissionStatus(m.id, 'blocked', cmd.actor, { reason: 'changes requested at review' });
          effect = 'correction recorded; mission held for rework';
        }
      } else if (decision.kind === 'failure_escalation' && decision.chosen === 'cancel') {
        kernel.cancelMission({ command: 'cancelMission', actor: cmd.actor, key: `${cmd.key}:cancel`, data: { mission_id: m.id, reason: `cancelled after failure: ${cmd.data.rationale}` } });
        effect = 'mission cancelled; artifacts kept';
      }
    }
    return this.env({ decision, effect }, this.sourceOf(decision.mission_id));
  }

  reviewDraft(cmd: Command<{ draft_id: string; approve: boolean; note: string }>): Envelope<{ draft: Draft }> {
    return this.env({ draft: this.rt.comms.reviewDraft(cmd) });
  }

  retrieveEvidence(mission_id: string): Envelope<{ packet: ReviewPacket | null; packet_markdown: string | null; event_count: number; chain_ok: boolean }> {
    const { kernel, store } = this.rt;
    const json = kernel.currentVersion(mission_id, 'review/packet');
    const md = kernel.currentVersion(mission_id, 'review/packet.md');
    const chain = store.verifyEventChain();
    if (!json) return { source: 'unavailable', reason: 'no review packet has been produced for this mission yet' };
    return this.env({ packet: JSON.parse(kernel.readArtifact(json) ?? 'null') as ReviewPacket | null, packet_markdown: md ? kernel.readArtifact(md) : null, event_count: store.events({ mission_id }).length, chain_ok: chain.ok }, this.sourceOf(mission_id));
  }

  /** A correction from the person the system works for. It is business evidence, not an agent suggestion. */
  recordCorrection(cmd: Command<{ mission_id: string; task_key: string | null; correction: string; failure_class: string }>): Envelope<{ observation_id: string; memory_id: string }> {
    const { store, kernel } = this.rt;
    return this.env(
      store.idempotent(cmd.key, 'recordCorrection', cmd.data, () => {
        const m = store.missions.must(cmd.data.mission_id);
        const task = cmd.data.task_key ? store.tasks.first('"mission_id" = ? AND "key" = ?', m.id, cmd.data.task_key) : undefined;
        const obs = kernel.observe({ mission_id: m.id, task_id: task?.id ?? null, kind: 'human_correction', failure_class: cmd.data.failure_class, certainty: 'verified', details: { correction: cmd.data.correction, by: cmd.actor }, component: 'execution', release_id: m.release_id, source: kernel.sourceOf(m.id) });
        const memory_id = newId('mem');
        store.memories.put({
          id: memory_id,
          kind: 'correction',
          statement: cmd.data.correction,
          scope: [`mission:${m.id}`, ...(m.scenario ? [`scenario:${m.scenario}`] : []), ...(task ? [`archetype:${task.contract.assignee.archetype}`] : [])],
          provenance: { mission_id: m.id, task_id: task?.id ?? null, evidence_ids: [], artifact_version_ids: [], release_id: m.release_id, recorded_by: cmd.actor },
          origin: 'business',
          certainty: 'verified',
          status: 'active',
          fresh_until: null,
          invalidated_by: null,
          superseded_by: null,
          validated_cases: 0,
          evidence_class: m.data_class === 'synthetic' ? 'synthetic' : 'empirical',
          created_at: store.clock.iso(),
        });
        store.emit({ type: 'human_correction_recorded', mission_id: m.id, task_id: task?.id ?? null, actor_id: cmd.actor, actor_kind: 'human', payload: { failure_class: cmd.data.failure_class, observation_id: obs.id, memory_id }, idempotency_key: cmd.key });
        return { observation_id: obs.id, memory_id };
      }).result,
      this.sourceOf(cmd.data.mission_id),
    );
  }
}
