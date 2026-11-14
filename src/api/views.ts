import type { CoordinationDef } from '../contracts/definitions.ts';
import type { Envelope, ImprovementReceipt, SourceLabel, Task } from '../contracts/types.ts';
import { criticalPath } from '../coordination/metrics.ts';
import { LocalChiefOfStaff } from '../cos/port.ts';
import type { Gate } from '../gate/gate.ts';
import { lineage } from '../memory/memory.ts';
import type { Runtime } from '../runtime.ts';

/**
 * Read models for the review interface. Every one is computed from persisted state and returned
 * in a provenance envelope: `source` says whether the data came from live model execution or a
 * labeled fixture, and an unavailable source carries a reason instead of zeros.
 */

type Src = Exclude<SourceLabel, 'unavailable'>;

function env<T>(rt: Runtime, data: T, source?: Src): Envelope<T> {
  const live = rt.store.missions.where('1=1').some((m) => m.provider_mode === 'live');
  return { source: source ?? (live ? 'live' : 'fixture'), generated_at: rt.store.clock.iso(), ...data };
}

function unavailable(reason: string): { source: 'unavailable'; reason: string } {
  return { source: 'unavailable', reason };
}

function progress(rt: Runtime, mission_id: string): { accepted: number; total: number; by_status: Record<string, number> } {
  const tasks = rt.store.tasks.where('"mission_id" = ?', mission_id).filter((t) => t.executor !== 'container');
  const by_status: Record<string, number> = {};
  for (const t of tasks) by_status[t.status] = (by_status[t.status] ?? 0) + 1;
  return { accepted: by_status.accepted ?? 0, total: tasks.length, by_status };
}

function taskCard(rt: Runtime, t: Task): Record<string, unknown> {
  const agent = rt.store.agents.get(t.owner_id);
  return {
    id: t.id,
    key: t.key,
    title: t.title,
    status: t.status,
    executor: t.executor,
    depth: t.depth,
    parent_task_id: t.parent_task_id,
    swarm_id: t.swarm_id,
    owner_id: t.owner_id,
    owner_label: agent ? `${agent.role} (${agent.archetype})` : t.owner_id,
    archetype: t.contract.assignee.archetype,
    currency: t.currency,
    attempt: t.attempt,
    generation: t.generation,
    blocked_reason: t.blocked_reason,
    next_action: t.next_action,
  };
}

export function overview(rt: Runtime, gate: Gate): Envelope<Record<string, unknown>> {
  if (!rt.registry.exists()) return unavailable('this state directory has not been initialised; run `swarm2 init`');
  const cos = new LocalChiefOfStaff(rt);
  const attention = cos.attention();
  const missions = rt.store.missions.where('1=1');
  const count = (s: string[]) => missions.filter((m) => s.includes(m.status)).length;
  const lastSeq = Number(rt.store.db.get<{ s: number }>('SELECT COALESCE(MAX(seq), 0) AS s FROM events')?.s ?? 0);
  return env(rt, {
    last_event_seq: lastSeq,
    active_release: rt.registry.active(),
    isolation: gate.iso,
    integrity: gate.integrity().ok,
    limits: { max_concurrent_model_calls: rt.limits.max_concurrent_model_calls, max_delegation_depth: rt.limits.max_delegation_depth, live_execution_enabled: rt.limits.live_execution_enabled, profile: rt.limits.name },
    providers: { fixture: rt.providers.fixture.available(), live: rt.providers.live.available() },
    counts: { planning: count(['proposed', 'planning']), doing: count(['active', 'blocked']), reviewing: count(['review_ready']), completed: count(['completed']), cancelled: count(['cancelled', 'failed']) },
    active_calls: rt.kernel.activeCalls(),
    attention: attention.source === 'unavailable' ? [] : attention.items,
    data_classes: [...new Set(missions.map((m) => m.data_class))],
    stopped: false,
  });
}

export function planning(rt: Runtime): Envelope<Record<string, unknown>> {
  const cos = new LocalChiefOfStaff(rt);
  const proposals = cos.proposals();
  const requests = rt.store.requests.where('1=1').sort((a, b) => a.received_at.localeCompare(b.received_at));
  const waiting = rt.store.missions.where(`"status" IN ('proposed', 'planning')`).sort((a, b) => a.priority - b.priority);
  return env(rt, {
    proposals: proposals.source === 'unavailable' ? [] : proposals.proposals.map((p) => ({ ...p, requests: p.request_ids.map((id) => rt.store.requests.get(id)).filter(Boolean) })),
    unassigned_requests: requests.filter((r) => !r.mission_id && !r.cluster_id),
    requests_total: requests.length,
    missions: waiting.map((m) => ({ id: m.id, title: m.title, objective: m.objective, priority: m.priority, status: m.status, release_id: m.release_id, provider_mode: m.provider_mode, data_class: m.data_class, budget: rt.store.accounts.must(m.budget_account_id).limit, requests: m.request_ids.length, revision: m.revision })),
    decisions: rt.store.decisions.where(`"status" IN ('open', 'escalated')`).filter((d) => ['rule_change', 'migration', 'failure_escalation'].includes(d.kind)).map((d) => ({ id: d.id, kind: d.kind, question: d.question, owner_id: d.owner_id, requires_human: d.requires_human, mission_id: d.mission_id, options: d.options.map((o) => ({ id: o.id, label: o.label, consequences: o.consequences })) })),
  });
}

export function doing(rt: Runtime): Envelope<Record<string, unknown>> {
  const missions = rt.store.missions.where(`"status" IN ('active', 'blocked', 'planning')`).sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
  return env(rt, {
    missions: missions.map((m) => {
      const tasks = rt.store.tasks.where('"mission_id" = ?', m.id);
      const open = tasks.filter((t) => t.next_action && !['accepted', 'cancelled', 'not_selected'].includes(t.status));
      const next = open.sort((a, b) => (b.next_action!.owner_kind === 'human' || b.next_action!.owner_kind === 'chief_of_staff' ? 1 : 0) - (a.next_action!.owner_kind === 'human' || a.next_action!.owner_kind === 'chief_of_staff' ? 1 : 0) || a.next_action!.since.localeCompare(b.next_action!.since))[0];
      const acct = rt.store.accounts.must(m.budget_account_id);
      return {
        id: m.id,
        title: m.title,
        status: m.status,
        priority: m.priority,
        accountable_human: m.accountable_human,
        release_id: m.release_id,
        provider_mode: m.provider_mode,
        data_class: m.data_class,
        migration: m.migration,
        progress: progress(rt, m.id),
        critical_path: tasks.length ? criticalPath(rt, m.id) : { keys: [], wait_ms: null },
        blockers: tasks.filter((t) => ['blocked', 'failed'].includes(t.status)).map((t) => ({ key: t.key, title: t.title, reason: t.blocked_reason ?? t.status, owner_id: t.next_action?.owner_id ?? null, owner_kind: t.next_action?.owner_kind ?? null })),
        next_action: next ? { task_key: next.key, task_id: next.id, ...next.next_action } : null,
        spent: rt.kernel.budget.spent(acct.id),
        budget: acct.limit,
        artifacts: rt.store.versions.where('"mission_id" = ? AND "currency" = ?', m.id, 'current').filter((v) => !v.key.startsWith('evidence/')).map((v) => ({ id: v.id, key: v.key, version_no: v.version_no, kind: rt.store.artifacts.must(v.artifact_id).kind, produced_by: v.produced_by_task_id ? (rt.store.tasks.get(v.produced_by_task_id)?.key ?? null) : null })),
      };
    }),
  });
}

/** The ownership graph: who owns each piece of unfinished work and whose move is next. */
export function ownership(rt: Runtime, mission_id?: string): Envelope<Record<string, unknown>> {
  const missions = mission_id ? [rt.store.missions.must(mission_id)] : rt.store.missions.where(`"status" IN ('active', 'blocked', 'planning', 'review_ready')`).sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
  return env(rt, {
    missions: missions.map((m) => {
      const tasks = rt.store.tasks.where('"mission_id" = ?', m.id).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.key.localeCompare(b.key));
      const decisions = rt.store.decisions.where(`"mission_id" = ? AND "status" IN ('open', 'escalated')`, m.id);
      return {
        id: m.id,
        title: m.title,
        status: m.status,
        accountable_human: m.accountable_human,
        // An unassigned or pending human decision stays visible.
        human_actions: decisions.filter((d) => d.requires_human).map((d) => ({ decision_id: d.id, owner_id: d.owner_id, question: d.question })),
        nodes: tasks.map((t) => taskCard(rt, t)),
      };
    }),
  });
}

export function reviewing(rt: Runtime): Envelope<Record<string, unknown>> {
  const cos = new LocalChiefOfStaff(rt);
  const ready = rt.store.missions.where(`"status" = 'review_ready'`);
  const done = rt.store.missions.where(`"status" IN ('completed', 'cancelled', 'failed')`).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return env(rt, {
    ready: ready.map((m) => {
      const ev = cos.retrieveEvidence(m.id);
      const review = rt.store.getMeta<{ decision_id: string; draft_id: string }>(`mission:${m.id}:review`);
      const decision = review ? rt.store.decisions.get(review.decision_id) : undefined;
      const draft = review ? rt.store.drafts.get(review.draft_id) : undefined;
      return {
        id: m.id,
        title: m.title,
        provider_mode: m.provider_mode,
        data_class: m.data_class,
        release_id: m.release_id,
        packet: ev.source === 'unavailable' ? null : ev.packet,
        packet_unavailable: ev.source === 'unavailable' ? ev.reason : null,
        decision: decision ? { id: decision.id, status: decision.status, question: decision.question, options: decision.options.map((o) => ({ id: o.id, label: o.label, consequences: o.consequences })) } : null,
        draft: draft ? { id: draft.id, title: draft.title, kind: draft.kind, audience: draft.audience, status: draft.status, body: draft.body, context_refs: draft.context_refs } : null,
        outcome: rt.store.outcomes.first('"mission_id" = ? AND "task_id" IS NULL', m.id) ?? null,
      };
    }),
    history: done.slice(0, 30).map((m) => ({ id: m.id, title: m.title, status: m.status, updated_at: m.updated_at, release_id: m.release_id, provider_mode: m.provider_mode, cancel_reason: m.cancel_reason, outcome: rt.store.outcomes.first('"mission_id" = ? AND "task_id" IS NULL', m.id) ?? null })),
  });
}

function receiptCard(r: ImprovementReceipt): Record<string, unknown> {
  return { receipt_id: r.receipt_id, experiment_id: r.experiment_id, level: r.level, decision: r.decision, justification: r.justification, decided_at: r.decided_at, evidence_basis: r.evidence_basis, holdout_set: r.evaluation.holdout_set, isolation_mode: r.isolation.mode, intact: r.isolation.intact, release_id: r.release_manifest?.release_id ?? null, primary: r.comparisons[0] ?? null };
}

export function evolution(rt: Runtime, gate: Gate): Envelope<Record<string, unknown>> {
  if (!rt.registry.exists()) return unavailable('this state directory has not been initialised; run `swarm2 init`');
  const active = rt.registry.active();
  const coord = rt.registry.load<CoordinationDef>(active, 'coordination');
  const experiments = gate.experiments.where('1=1').sort((a, b) => a.created_at.localeCompare(b.created_at));
  const receipts = gate.receipts.where('1=1').sort((a, b) => a.decided_at.localeCompare(b.decided_at));
  const releases = rt.registry.list();
  return env(
    rt,
    {
      organization: {
        active_release: active,
        baseline_release: rt.registry.baseline(),
        components: rt.registry.manifest(active).components,
        archetypes: Object.entries(coord.archetypes).map(([name, a]) => ({ name, responsibility: a.responsibility, activate_when: a.activate_when })),
        coordination: { interface_agreement_before_parallel: coord.decomposition.interface_agreement_before_parallel, independent_verification: coord.reviewer_assignment.independent_verification, verify_each_merge: coord.integration.verify_each_merge },
        isolation: gate.iso,
        integrity: gate.integrity(),
        ledger: gate.verifyLedger(),
      },
      releases: releases.map((m) => ({ ...m, missions_pinned: rt.store.missions.count('"release_id" = ?', m.release_id) })),
      experiments: experiments.map((e) => ({ id: e.id, title: e.title, level: e.level, stage: e.stage, decision: e.decision, lineage_id: e.lineage_id, revises: e.revises, holdout_set: e.protocol?.holdout_set ?? null, frozen_at: e.protocol?.frozen_at ?? null, receipt_id: e.receipt_id, release_id: e.release_id, canary_id: e.canary_id, hypothesis: e.hypothesis, candidate: e.candidate ? { candidate_id: e.candidate.candidate_id, hash: e.candidate.candidate_hash, files: e.candidate.files.map((f) => f.path) } : null, source: e.source })),
      receipts: receipts.map(receiptCard),
      canaries: gate.canaries.where('1=1').sort((a, b) => a.started_at.localeCompare(b.started_at)),
      rollbacks: gate.ledger().filter((l) => l.kind === 'rollback').map((l) => ({ at: l.at, ...l.payload })),
      rule_change_proposals: rt.store.decisions.where(`"kind" = 'rule_change'`).map((d) => ({ id: d.id, question: d.question, status: d.status, chosen: d.chosen })),
      observations: Object.entries(rt.store.observations.where('1=1').reduce((a: Record<string, number>, o) => ((a[`${o.kind}:${o.failure_class}`] = (a[`${o.kind}:${o.failure_class}`] ?? 0) + 1), a), {})).map(([k, n]) => ({ signature: k, count: n })).sort((a, b) => b.count - a.count).slice(0, 12),
    },
    experiments.some((e) => e.source === 'live') ? 'live' : 'fixture',
  );
}

export function receipt(gate: Gate, id: string): Envelope<{ receipt: ImprovementReceipt }> {
  const r = gate.receipts.get(id);
  if (!r) return unavailable(`no receipt ${id}`);
  return { source: r.evidence_basis === 'live' ? 'live' : r.evidence_basis === 'simulation' ? 'simulation' : 'fixture', generated_at: r.decided_at, receipt: r };
}

export function missionDetail(rt: Runtime, id: string): Envelope<Record<string, unknown>> {
  const m = rt.store.missions.get(id);
  if (!m) return unavailable(`no mission ${id}`);
  const swarms = rt.store.swarms.where('"mission_id" = ?', id);
  return env(rt, {
    mission: m,
    swarms: swarms.map((s) => ({ id: s.id, archetype: s.archetype, purpose: s.purpose, deliverable: s.deliverable, stopping_condition: s.stopping_condition, lead: rt.store.agents.get(s.lead_agent_id)?.role ?? s.lead_agent_id, parent_swarm_id: s.parent_swarm_id, depth: s.depth, temporary: s.temporary, status: s.status, container_task_id: s.container_task_id })),
    lineage: lineage(rt, id),
    needs: rt.store.needs.where('"mission_id" = ?', id),
    handoffs: rt.store.handoffs.where('"mission_id" = ?', id),
    integration: rt.store.integration.where('"mission_id" = ?', id).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    communication: rt.comms.overhead(id),
  }, m.provider_mode === 'live' ? 'live' : 'fixture');
}

export function taskDetail(rt: Runtime, id: string): Envelope<Record<string, unknown>> {
  const t = rt.store.tasks.get(id);
  if (!t) return unavailable(`no task ${id}`);
  const m = rt.store.missions.must(t.mission_id);
  return env(rt, {
    task: taskCard(rt, t),
    contract: t.contract,
    attempts: rt.store.attempts.where('"task_id" = ?', id).sort((a, b) => a.attempt_no - b.attempt_no),
    artifacts: rt.store.versions.where('"produced_by_task_id" = ?', id).map((v) => ({ id: v.id, key: v.key, version_no: v.version_no, currency: v.currency, content_hash: v.content_hash, media_type: v.media_type, size: v.size })),
    verifications: rt.store.verifications.where('"task_id" = ?', id).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    evidence: rt.store.evidence.where('"task_id" = ?', id),
    // Raw identifiers are demoted: an owner is shown by role, not by id.
    escalation_labels: t.contract.escalation.path.map((p) => { const a = rt.store.agents.get(p); return a ? `${a.role} (${a.archetype})` : p.replace(/_/g, ' '); }),
    dependencies: rt.kernel.dependenciesOf(id).map((d) => rt.store.tasks.get(d)?.key ?? d),
    verifies: rt.kernel.verificationTargets(id).map((d) => rt.store.tasks.get(d)?.key ?? d),
    budget: { limit: rt.store.accounts.must(t.budget_account_id).limit, spent: rt.kernel.budget.spent(t.budget_account_id) },
    events: rt.store.events({ task_id: id }).slice(-60),
  }, m.provider_mode === 'live' ? 'live' : 'fixture');
}

export function artifactContent(rt: Runtime, version_id: string): Envelope<Record<string, unknown>> {
  const v = rt.store.versions.get(version_id);
  if (!v) return unavailable(`no artifact version ${version_id}`);
  const content = rt.kernel.readArtifact(v);
  return env(rt, { version: v, content: content === null ? null : content.slice(0, 200_000), note: content === null ? 'This artifact is a git commit; see the exact changes in the review packet.' : null }, v.source === 'unavailable' ? 'fixture' : v.source);
}

/** Primary outcome metrics. Diagnostic activity counts are reported separately and labeled as such. */
export function metrics(rt: Runtime, gate: Gate): Envelope<Record<string, unknown>> {
  const outcomes = rt.store.outcomes.where('"task_id" IS NULL');
  if (outcomes.length === 0) return unavailable('no mission has reached an outcome yet');
  const n = outcomes.length;
  const sum = (f: (o: (typeof outcomes)[number]) => number): number => outcomes.reduce((a, o) => a + f(o), 0);
  const accepted = outcomes.filter((o) => o.verified_success);
  const escaped = outcomes.filter((o) => o.escaped_defects !== null);
  const receipts = gate.receipts.where('1=1');
  const recoveries = rt.store.events({ type: 'lease_expired' }).length + rt.store.events({ type: 'attempt_orphaned' }).length;
  return env(rt, {
    primary: {
      independently_accepted_outcomes: { value: accepted.length, of: n },
      acceptance_failures: sum((o) => o.rework_count),
      escaped_defects: escaped.length ? escaped.reduce((a, o) => a + (o.escaped_defects ?? 0), 0) : null,
      human_corrections: sum((o) => o.human_corrections),
      worker_invocations_per_accepted_outcome: accepted.length ? sum((o) => o.total_usage.worker_invocations) / accepted.length : null,
      mean_completion_ms: sum((o) => o.elapsed_ms) / n,
      mean_critical_path_wait_ms: outcomes.every((o) => o.critical_path_wait_ms !== null) ? sum((o) => o.critical_path_wait_ms ?? 0) / n : null,
      integration_failures: sum((o) => o.integration_failures),
      recovery_events: recoveries,
      improvements_accepted: receipts.filter((r) => r.decision === 'accept').length,
      improvements_rejected: receipts.filter((r) => r.decision === 'reject').length,
      improvements_inconclusive: receipts.filter((r) => r.decision === 'inconclusive').length,
      rollbacks_after_promotion: gate.ledger().filter((l) => l.kind === 'rollback').length,
    },
    diagnostic_activity: { note: 'Counts of activity, not of value.', agents: rt.store.agents.count(), messages: rt.store.messages.count(), artifacts: rt.store.versions.count(), attempts: rt.store.attempts.count(), events: rt.store.events().length },
  });
}
