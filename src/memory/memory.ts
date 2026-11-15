import type { Memory, MemoryKind, Mission, Task } from '../contracts/types.ts';
import { jaccard, tokenize } from '../kernel/intake.ts';
import type { Runtime } from '../runtime.ts';
import { newId, truncate, SwarmError } from '../lib/util.ts';

const DAY = 24 * 3600 * 1000;

interface Note {
  kind: MemoryKind;
  statement: string;
  scope: string[];
  source_refs: string[];
  certainty?: 'verified' | 'suspected' | 'untested';
  fresh_for_days?: number;
}

/**
 * Turn accepted knowledge notes into scoped memories. Every memory keeps where it came from
 * (mission, task, artifact versions, release), where it applies, how long it stays fresh, and
 * whether it is a verified fact, a suspected cause, or an untested idea.
 */
export function ingestKnowledge(rt: Runtime, task: Task, doc: Record<string, unknown>): Memory[] {
  const { store, kernel } = rt;
  const m = store.missions.must(task.mission_id);
  const out: Memory[] = [];
  const resolveRefs = (refs: string[]): { evidence_ids: string[]; artifact_version_ids: string[] } => {
    if (!Array.isArray(refs) || refs.length === 0) throw new SwarmError('memory_source_missing', 'Knowledge requires resolvable sources');
    const evidence_ids: string[] = [], artifact_version_ids: string[] = [];
    for (const ref of refs) {
      const v = kernel.currentVersion(m.id, ref);
      const e = store.evidence.get(ref);
      const o = store.observations.get(ref);
      if (v?.currency === 'current') artifact_version_ids.push(v.id);
      else if (e?.mission_id === m.id && e.freshness_status === 'fresh') evidence_ids.push(e.id);
      else if (o?.mission_id === m.id) evidence_ids.push(o.id);
      else throw new SwarmError('memory_source_missing', `Unknown or stale source for this mission: ${ref}`);
    }
    return { evidence_ids, artifact_version_ids };
  };
  const base = (kind: MemoryKind, statement: string, scope: string[], refs: string[], certainty: Memory['certainty'], days: number | null): Memory => ({
    id: newId('mem'),
    kind,
    statement: truncate(statement, 600),
    scope,
    provenance: { mission_id: m.id, task_id: task.id, ...resolveRefs(refs), release_id: m.release_id, recorded_by: task.owner_id },
    origin: 'agent',
    certainty,
    status: 'active',
    fresh_until: days === null ? null : new Date(store.clock.now() + days * DAY).toISOString(),
    invalidated_by: null,
    superseded_by: null,
    validated_cases: 0,
    // What a fixture or synthetic mission taught is synthetic evidence. It never counts as empirical.
    evidence_class: m.data_class === 'synthetic' || m.provider_mode === 'fixture' ? 'synthetic' : 'empirical',
    created_at: store.clock.iso(),
  });
  for (const n of (doc.notes ?? []) as Note[]) {
    // A procedure is an untested idea until it has been validated on further cases.
    if (!['fact', 'interpretation', 'procedure', 'failed_approach', 'decision'].includes(n.kind) || typeof n.statement !== 'string' || !Array.isArray(n.scope) || !n.scope.every((s) => typeof s === 'string')) throw new SwarmError('invalid_memory', 'Invalid agent knowledge note');
    if (n.fresh_for_days !== undefined && (!Number.isFinite(n.fresh_for_days) || n.fresh_for_days <= 0 || n.fresh_for_days > 365)) throw new SwarmError('invalid_memory', 'Knowledge freshness must be between 0 and 365 days');
    // Resolving a reference does not independently prove the claim about it.
    const certainty = n.kind === 'procedure' ? 'untested' : 'suspected';
    out.push(base(n.kind, n.statement, n.scope, n.source_refs, certainty, n.fresh_for_days ?? 90));
  }
  const skill = doc.skill_candidate as { id: string; title: string; procedure: string[]; supported_situations?: string[] } | undefined;
  if (skill) out.push(base('skill_candidate', `${skill.title}: ${skill.procedure.join(' → ')}`, ['skill:' + skill.id, ...(skill.supported_situations ?? []).map(() => 'pattern:producer-consumer').slice(0, 1)], ['knowledge/mission-notes'], 'untested', 180));
  store.db.tx(() => {
    for (const mem of out) {
      // The same statement in the same scope supersedes its earlier copy instead of piling up.
      const prior = store.memories.where(`"kind" = ? AND "status" = 'active'`, mem.kind).find((p) => p.provenance.mission_id === m.id && p.statement === mem.statement && p.scope.join('|') === mem.scope.join('|'));
      if (prior) store.memories.put({ ...prior, status: 'superseded', superseded_by: mem.id });
      store.memories.put(mem);
    }
    store.emit({ type: 'knowledge_recorded', mission_id: m.id, task_id: task.id, actor_id: task.owner_id, actor_kind: 'agent', payload: { memories: out.map((x) => ({ id: x.id, kind: x.kind, certainty: x.certainty })), release_id: m.release_id } });
  });
  return out;
}

export interface Retrieved {
  memory: Memory;
  score: number;
  why: string;
}

/** Mark memories whose freshness window has passed. Returns how many expired. */
export function expireMemories(rt: Runtime): number {
  const now = rt.store.clock.iso();
  let n = 0;
  for (const mem of rt.store.memories.where(`"status" = 'active'`)) {
    if (mem.fresh_until && mem.fresh_until < now) {
      rt.store.memories.put({ ...mem, status: 'expired' });
      n++;
    }
  }
  return n;
}

/**
 * Select the memories relevant to a task. Scope must match; wording similarity only orders the
 * matches. Invalidated, superseded and expired memories are never returned.
 */
export function retrieve(rt: Runtime, q: { scopes: string[]; text: string; kinds?: MemoryKind[]; limit: number; include_failed_approaches: boolean; mission_id?: string }): Retrieved[] {
  expireMemories(rt);
  const terms = tokenize(q.text);
  const out: Retrieved[] = [];
  for (const mem of rt.store.memories.where(`"status" = 'active'`)) {
    const source = mem.provenance.mission_id ? rt.store.missions.get(mem.provenance.mission_id) : undefined;
    const target = q.mission_id ? rt.store.missions.must(q.mission_id) : undefined;
    // Cross-mission reuse is limited to synthetic fixture work until source ACLs exist.
    if (target && source?.id !== target.id && !(target.data_class === 'synthetic' && target.provider_mode === 'fixture' && source?.data_class === 'synthetic' && source.provider_mode === 'fixture')) continue;
    if (mem.provenance.artifact_version_ids.some((id) => rt.store.versions.get(id)?.currency !== 'current')) continue;
    if (q.kinds && !q.kinds.includes(mem.kind)) continue;
    if (mem.kind === 'failed_approach' && !q.include_failed_approaches) continue;
    const shared = mem.scope.filter((s) => q.scopes.includes(s));
    if (shared.length === 0) continue;
    const lexical = jaccard(terms, tokenize(mem.statement));
    const weight = mem.kind === 'correction' ? 0.3 : mem.certainty === 'verified' ? 0.15 : 0;
    out.push({ memory: mem, score: shared.length + lexical + weight, why: `scope ${shared.join(', ')}${lexical > 0.05 ? `; wording overlap ${lexical.toFixed(2)}` : ''}` });
  }
  return out.sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id)).slice(0, q.limit);
}

const LABEL: Record<MemoryKind, string> = { fact: 'FACT', interpretation: 'INTERPRETATION', procedure: 'PROCEDURE', failed_approach: 'FAILED APPROACH', decision: 'DECISION', correction: 'CORRECTION FROM A PERSON', skill_candidate: 'CANDIDATE SKILL' };

/**
 * The context a worker is given. Uncertainty and sources survive: every line says what kind of
 * knowledge it is, how certain, and where it came from.
 */
export function contextPacket(rt: Runtime, mission: Mission, task: Task, opts: { max: number; include_failed_approaches: boolean }): { text: string; memory_ids: string[] } {
  const scopes = [`archetype:${task.contract.assignee.archetype}`, ...(mission.scenario ? [`scenario:${mission.scenario}`] : []), `mission:${mission.id}`];
  const got = retrieve(rt, { scopes, text: `${task.title} ${task.contract.objective}`, limit: opts.max, include_failed_approaches: opts.include_failed_approaches, mission_id: mission.id });
  if (got.length === 0) return { text: '', memory_ids: [] };
  const lines = ['# What the organization already knows (check it against your inputs before relying on it)'];
  for (const { memory: mem } of got) {
    const sure = mem.certainty === 'verified' ? 'verified' : mem.certainty === 'untested' ? 'untested idea' : 'suspected, not verified';
    const src = mem.origin === 'business' ? 'from a person' : `recorded by an agent in mission ${mem.provenance.mission_id ?? 'unknown'}`;
    lines.push(`- ${LABEL[mem.kind]} (${sure}; ${mem.evidence_class} evidence; ${src}): ${mem.statement}`);
  }
  rt.store.emit({ type: 'context_selected', mission_id: mission.id, task_id: task.id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: task.key, selected: got.map((g) => ({ id: g.memory.id, kind: g.memory.kind, why: g.why })) } });
  rt.store.setMeta(`task:${task.id}:context:g${task.generation}`, got.map((g) => g.memory.id));
  return { text: lines.join('\n'), memory_ids: got.map((g) => g.memory.id) };
}

/** A memory is withdrawn with a reason; it is kept for the record and never returned again. */
export function invalidateMemory(rt: Runtime, id: string, reason: string): Memory {
  const mem = rt.store.memories.must(id);
  const next: Memory = { ...mem, status: 'invalidated', invalidated_by: reason };
  rt.store.memories.put(next);
  rt.store.emit({ type: 'memory_invalidated', mission_id: mem.provenance.mission_id, actor_id: 'runtime', actor_kind: 'runtime', payload: { memory_id: id, kind: mem.kind, reason } });
  return next;
}

/**
 * Bring an expired or invalidated failed approach back for another look because the environment
 * changed. It returns as a suspicion, not as a verified failure.
 */
export function reconsider(rt: Runtime, id: string, why: string): Memory {
  const mem = rt.store.memories.must(id);
  const next: Memory = { ...mem, status: 'active', certainty: 'suspected', invalidated_by: null, fresh_until: new Date(rt.store.clock.now() + 30 * DAY).toISOString() };
  rt.store.memories.put(next);
  rt.store.emit({ type: 'memory_reconsidered', mission_id: mem.provenance.mission_id, actor_id: 'runtime', actor_kind: 'runtime', payload: { memory_id: id, why } });
  return next;
}

/**
 * Credit the memories a mission's workers were given when the mission is independently accepted.
 * A procedure or candidate skill only becomes eligible to be a default after it has been used in
 * further accepted work.
 */
export function creditMemories(rt: Runtime, mission_id: string): number {
  const outcome = rt.store.outcomes.first('"mission_id" = ? AND "task_id" IS NULL', mission_id);
  if (!outcome?.verified_success) return 0;
  const ids = new Set<string>();
  for (const t of rt.store.tasks.where('"mission_id" = ?', mission_id)) {
    for (const id of rt.store.getMeta<string[]>(`task:${t.id}:context:g${t.generation}`) ?? []) ids.add(id);
  }
  let n = 0;
  for (const id of ids) {
    const mem = rt.store.memories.get(id);
    // Work in the mission that produced a memory does not validate it.
    const credit = `memory:${id}:credited:${mission_id}`;
    if (!mem || mem.status !== 'active' || mem.provenance.mission_id === mission_id || rt.store.getMeta<boolean>(credit)) continue;
    rt.store.setMeta(credit, true);
    rt.store.memories.put({ ...mem, validated_cases: mem.validated_cases + 1 });
    n++;
  }
  return n;
}

/** The queryable chain: mission → task → evidence → decision → artifact → verification → outcome. */
export function lineage(rt: Runtime, mission_id: string): Record<string, unknown> {
  const { store } = rt;
  const m = store.missions.must(mission_id);
  const tasks = store.tasks.where('"mission_id" = ?', mission_id);
  return {
    mission: { id: m.id, title: m.title, status: m.status, release_id: m.release_id, provider_mode: m.provider_mode },
    tasks: tasks.map((t) => ({
      key: t.key,
      status: t.status,
      owner_id: t.owner_id,
      generation: t.generation,
      attempts: store.attempts.where('"task_id" = ?', t.id).map((a) => ({ attempt_no: a.attempt_no, status: a.status, provider: a.provider, model_requested: a.model_requested, model_actual: a.model_actual })),
      evidence: store.evidence.where('"task_id" = ?', t.id).map((e) => ({ id: e.id, kind: e.kind, epistemic: e.epistemic, origin: e.origin, statement: truncate(e.statement, 160) })),
      artifacts: store.versions.where('"produced_by_task_id" = ?', t.id).map((v) => ({ key: v.key, version_no: v.version_no, currency: v.currency, content_hash: v.content_hash })),
      verifications: store.verifications.where('"task_id" = ? AND "generation" = ?', t.id, t.generation).map((v) => ({ criterion_id: v.criterion_id, verdict: v.verdict, independent: v.independent, method: v.method, evidence_ids: v.evidence_ids })),
    })),
    decisions: store.decisions.where('"mission_id" = ?', mission_id).map((d) => ({ id: d.id, kind: d.kind, status: d.status, chosen: d.chosen, owner_id: d.owner_id, superseded_by: d.superseded_by })),
    outcome: store.outcomes.first('"mission_id" = ? AND "task_id" IS NULL', mission_id) ?? null,
    memories: store.memories.where('1=1').filter((x) => x.provenance.mission_id === mission_id).map((x) => ({ id: x.id, kind: x.kind, certainty: x.certainty, status: x.status })),
    observations: store.observations.where('"mission_id" = ?', mission_id).map((o) => ({ id: o.id, kind: o.kind, failure_class: o.failure_class, certainty: o.certainty })),
  };
}
