import type { BudgetClass, Mission, PlanProposal, Swarm, SwarmArchetype, Task } from '../contracts/types.ts';
import type { Kernel } from '../kernel/kernel.ts';
import { SwarmError, scaleAmounts } from '../lib/util.ts';

const CLASS_FOR: Record<SwarmArchetype, BudgetClass> = {
  discovery: 'delivery',
  planning: 'delivery',
  delivery: 'delivery',
  verification: 'verification',
  evolution: 'exploration',
  reliability: 'completion',
};

function planShapeErrors(plan: unknown): string[] {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) return ['it is not an object'];
  const p = plan as Record<string, unknown>;
  const out: string[] = [];
  if (typeof p.topology !== 'string') out.push('topology is missing');
  if (p.anchor !== 'mission' && p.anchor !== 'own_swarm') out.push('anchor must be "mission" or "own_swarm"');
  for (const k of ['swarms', 'tasks', 'interface_agreements', 'extra_dependencies']) if (!Array.isArray(p[k])) out.push(`${k} is not a list`);
  if (out.length) return out;
  const str = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
  (p.swarms as Record<string, unknown>[]).forEach((s, i) => {
    if (s === null || typeof s !== 'object') return void out.push(`swarm ${i} is not an object`);
    if (!str(s.ref) || !str(s.archetype)) out.push(`swarm ${i} lacks a ref or an archetype`);
    if (typeof s.budget_share !== 'number') out.push(`swarm ${String(s.ref ?? i)} has no budget share`);
    if (s.depends_on !== undefined && !Array.isArray(s.depends_on)) out.push(`swarm ${String(s.ref ?? i)}: depends_on is not a list`);
  });
  (p.tasks as Record<string, unknown>[]).forEach((t, i) => {
    if (t === null || typeof t !== 'object') return void out.push(`task ${i} is not an object`);
    if (!str(t.ref) || !str(t.swarm_ref) || !str(t.title)) out.push(`task ${i} lacks a ref, a swarm or a title`);
    for (const k of ['depends_on', 'verifies', 'input_keys', 'outputs', 'acceptance_criteria', 'write_scope']) if (!Array.isArray(t[k])) out.push(`task ${String(t.ref ?? i)}: ${k} is not a list`);
    if (t.verification === null || typeof t.verification !== 'object') out.push(`task ${String(t.ref ?? i)} has no verification method`);
    if (typeof t.budget_share !== 'number') out.push(`task ${String(t.ref ?? i)} has no budget share`);
  });
  return out.slice(0, 8);
}

/**
 * Check a proposed plan before anything is created. Agents propose; the runtime decides whether
 * the proposal is structurally sound and within the proposer's authority.
 */
export function validatePlan(kernel: Kernel, mission: Mission, plan: PlanProposal, proposer: Task | null): string[] {
  const errors: string[] = [];
  // A proposal is untrusted input. Its shape is checked before anything reads it, so a malformed
  // one is refused with a reason instead of breaking the step that validates it.
  const shape = planShapeErrors(plan);
  if (shape.length) return [`the proposed plan is malformed: ${shape.join('; ')}`];
  const swarmRefs = new Set(plan.swarms.map((s) => s.ref));
  const taskRefs = new Set(plan.tasks.map((t) => t.ref));
  const existing = new Map(kernel.store.tasks.where('"mission_id" = ?', mission.id).map((t) => [t.key, t]));

  if (plan.anchor === 'mission' && proposer && proposer.contract.assignee.archetype !== 'planning') {
    errors.push(`only mission coordination may anchor a plan at the mission; ${proposer.key} is in the ${proposer.contract.assignee.archetype} swarm`);
  }
  if (plan.anchor === 'own_swarm' && (!proposer || !proposer.parent_task_id)) errors.push('a plan anchored in its own swarm needs a proposer that belongs to a swarm');
  if (new Set([...swarmRefs, ...taskRefs]).size !== plan.swarms.length + plan.tasks.length) errors.push('references must be unique');
  for (const ref of [...swarmRefs, ...taskRefs]) if (existing.has(ref)) errors.push(`reference ${ref} already exists in this mission`);

  for (const s of plan.swarms) {
    // A team without a bounded purpose, deliverable, stopping condition and budget is not created.
    for (const f of ['purpose', 'deliverable', 'stopping_condition'] as const) if (!s[f]?.trim()) errors.push(`team ${s.ref} has no ${f.replace('_', ' ')}`);
    if (!(s.budget_share > 0 && s.budget_share <= 1)) errors.push(`team ${s.ref} needs a budget share in (0, 1]`);
    if (s.parent_ref && !swarmRefs.has(s.parent_ref)) errors.push(`team ${s.ref} has unknown parent ${s.parent_ref}`);
    for (const d of s.depends_on) if (!taskRefs.has(d) && !swarmRefs.has(d) && !existing.has(d)) errors.push(`team ${s.ref} depends on unknown ${d}`);
  }
  const shareByParent = new Map<string, number>();
  for (const s of plan.swarms) shareByParent.set(`${s.parent_ref ?? '(anchor)'}:${CLASS_FOR[s.archetype]}`, (shareByParent.get(`${s.parent_ref ?? '(anchor)'}:${CLASS_FOR[s.archetype]}`) ?? 0) + s.budget_share);
  for (const t of plan.tasks) {
    const special = (plan.anchor === 'own_swarm' && t.swarm_ref === '(own)') || (plan.anchor === 'mission' && t.swarm_ref === '(mission)');
    if (!swarmRefs.has(t.swarm_ref) && !special) errors.push(`task ${t.ref} belongs to unknown team ${t.swarm_ref}`);
    if (t.executor !== 'container' && t.acceptance_criteria.length === 0 && t.verification.method !== 'none') errors.push(`task ${t.ref} has no acceptance criteria`);
    if (t.acceptance_criteria.some((c) => c.mandatory) && t.verification.method === 'none') errors.push(`task ${t.ref} has mandatory criteria but no verification method`);
    if (!(t.budget_share > 0 && t.budget_share <= 1)) errors.push(`task ${t.ref} needs a budget share in (0, 1]`);
    for (const d of [...t.depends_on, ...t.verifies]) if (!taskRefs.has(d) && !swarmRefs.has(d) && !existing.has(d)) errors.push(`task ${t.ref} references unknown ${d}`);
    shareByParent.set(`task:${t.swarm_ref}`, (shareByParent.get(`task:${t.swarm_ref}`) ?? 0) + t.budget_share);
  }
  for (const [k, v] of shareByParent) if (v > 1 + 1e-9) errors.push(`budget shares under ${k} add up to ${v.toFixed(2)}, more than the parent holds`);

  // Cycle check over the proposed prerequisite edges.
  const edges = new Map<string, string[]>();
  for (const t of plan.tasks) edges.set(t.ref, t.depends_on.filter((d) => taskRefs.has(d)));
  const state = new Map<string, number>();
  const visit = (n: string): boolean => {
    if (state.get(n) === 1) return true;
    if (state.get(n) === 2) return false;
    state.set(n, 1);
    for (const d of edges.get(n) ?? []) if (visit(d)) return true;
    state.set(n, 2);
    return false;
  };
  for (const t of plan.tasks) if (visit(t.ref)) {
    errors.push(`dependency cycle through ${t.ref}`);
    break;
  }

  // Concurrent coding work must not share a write scope.
  const coders = plan.tasks.filter((t) => t.outputs.some((o) => o.kind === 'code') && t.executor === 'worker');
  for (let i = 0; i < coders.length; i++) {
    for (let j = i + 1; j < coders.length; j++) {
      const shared = coders[i]!.write_scope.filter((w) => coders[j]!.write_scope.includes(w));
      if (shared.length) errors.push(`tasks ${coders[i]!.ref} and ${coders[j]!.ref} share write scope ${shared.join(', ')}`);
    }
  }
  for (const a of plan.interface_agreements) {
    if (!kernel.currentVersion(mission.id, a.artifact_key) && !plan.tasks.some((t) => t.outputs.some((o) => o.key === a.artifact_key))) errors.push(`interface ${a.artifact_key} is required but nothing produces it`);
    for (const ref of a.between) {
      const t = plan.tasks.find((x) => x.ref === ref);
      if (t && !t.input_keys.includes(a.artifact_key)) errors.push(`task ${ref} must pin the agreed interface ${a.artifact_key}`);
    }
  }
  for (const x of plan.extra_dependencies) {
    const target = existing.get(x.task_key);
    if (!target) errors.push(`cannot add prerequisites to unknown task ${x.task_key}`);
    else if (proposer && target.parent_task_id !== proposer.parent_task_id) errors.push(`${proposer.key} may only add prerequisites inside its own swarm`);
  }
  return errors;
}

/** Create the teams, agents and tasks of a validated plan. Everything happens in one transaction. */
export function materializePlan(kernel: Kernel, mission: Mission, plan: PlanProposal, proposer: Task | null): { swarms: Swarm[]; tasks: Task[] } {
  const errors = validatePlan(kernel, mission, plan, proposer);
  if (errors.length) throw new SwarmError('invalid_plan', `Plan rejected: ${errors.join('; ')}`, { errors });
  const store = kernel.store;
  return store.db.tx(() => {
    const anchorTask = plan.anchor === 'own_swarm' && proposer?.parent_task_id ? store.tasks.must(proposer.parent_task_id) : null;
    const anchorSwarm = anchorTask?.swarm_id ? store.swarms.must(anchorTask.swarm_id) : null;
    const containerOf = new Map<string, Task>();
    const swarmOf = new Map<string, Swarm>();
    const idOf = new Map<string, string>();
    const resolve = (ref: string): string => idOf.get(ref) ?? store.tasks.first('"mission_id" = ? AND "key" = ?', mission.id, ref)?.id ?? ref;
    if (anchorTask && anchorSwarm) {
      containerOf.set('(own)', anchorTask);
      swarmOf.set('(own)', anchorSwarm);
    }
    const swarms: Swarm[] = [];
    const tasks: Task[] = [];

    // Parents before children.
    const ordered = [...plan.swarms].sort((a, b) => depthOf(a.ref) - depthOf(b.ref));
    function depthOf(ref: string): number {
      const s = plan.swarms.find((x) => x.ref === ref);
      return s?.parent_ref ? depthOf(s.parent_ref) + 1 : 0;
    }
    for (const s of ordered) {
      const parentContainer = s.parent_ref ? containerOf.get(s.parent_ref)! : anchorTask;
      const parentSwarm = s.parent_ref ? swarmOf.get(s.parent_ref)! : anchorSwarm;
      const basis = parentContainer ? parentContainer.contract.resources.reservation : store.accounts.must(kernel.classAccount(mission.id, CLASS_FOR[s.archetype])).limit;
      const lead = kernel.createAgent({ mission_id: mission.id, swarm_id: null, archetype: s.archetype, role: `${s.archetype}-lead`, model_requested: null });
      const container = kernel.createTask({
        mission_id: mission.id,
        parent_task_id: parentContainer?.id ?? null,
        swarm_id: null,
        key: s.ref,
        title: `${s.archetype} swarm: ${s.purpose}`,
        objective: s.deliverable,
        executor: 'container',
        assignee: { kind: 'swarm', archetype: s.archetype, role: `${s.archetype}-lead` },
        owner_id: lead.id,
        acceptance_criteria: [],
        depends_on: s.depends_on.map(resolve),
        input_keys: [],
        required_outputs: [],
        verification: { method: 'none', independent: false },
        authority: parentContainer ? parentContainer.contract.authority : mission.authorization,
        reservation: scaleAmounts(basis, s.budget_share),
        budget_class: CLASS_FOR[s.archetype],
        stopping_conditions: [s.stopping_condition],
      });
      const swarm = kernel.createSwarm({
        mission_id: mission.id,
        parent_swarm_id: parentSwarm?.id ?? null,
        archetype: s.archetype,
        purpose: s.purpose,
        lead_agent_id: lead.id,
        deliverable: s.deliverable,
        stopping_condition: s.stopping_condition,
        budget_account_id: container.budget_account_id,
        container_task_id: container.id,
        temporary: s.temporary,
        depth: container.depth,
      });
      lead.swarm_id = swarm.id;
      store.agents.put(lead);
      container.swarm_id = swarm.id;
      store.tasks.put(container);
      containerOf.set(s.ref, container);
      swarmOf.set(s.ref, swarm);
      idOf.set(s.ref, container.id);
      swarms.push(swarm);
      tasks.push(container);
    }

    const agentFor = new Map<string, string>();
    const leaf = plan.tasks.filter((t) => !plan.swarms.some((s) => s.ref === t.ref));
    // Create in dependency order so prerequisite ids exist.
    const pending = [...leaf];
    let guard = pending.length * pending.length + 5;
    while (pending.length && guard-- > 0) {
      const t = pending.shift()!;
      const unresolved = [...t.depends_on, ...t.verifies].filter((d) => leaf.some((x) => x.ref === d) && !idOf.has(d));
      if (unresolved.length) {
        pending.push(t);
        continue;
      }
      // `(mission)` places a task directly under the mission, owned by mission coordination.
      const container = containerOf.get(t.swarm_ref) ?? null;
      const swarm = swarmOf.get(t.swarm_ref) ?? null;
      const archetype: SwarmArchetype = swarm?.archetype ?? 'planning';
      const agentKey = `${swarm?.id ?? 'mission'}:${t.role}`;
      if (!agentFor.has(agentKey)) {
        const reuse = swarm ? store.agents.first('"swarm_id" = ? AND "role" = ?', swarm.id, t.role) : store.agents.first('"mission_id" = ? AND "swarm_id" IS NULL AND "role" = ?', mission.id, t.role);
        agentFor.set(agentKey, (reuse ?? kernel.createAgent({ mission_id: mission.id, swarm_id: swarm?.id ?? null, archetype, role: t.role, model_requested: null })).id);
      }
      const basis = container ? container.contract.resources.reservation : store.accounts.must(kernel.classAccount(mission.id, t.budget_class)).limit;
      const authority = container ? container.contract.authority : mission.authorization;
      const task = kernel.createTask({
        mission_id: mission.id,
        parent_task_id: container?.id ?? null,
        swarm_id: swarm?.id ?? null,
        key: t.ref,
        title: t.title,
        objective: t.objective,
        executor: t.executor,
        assignee: { kind: 'agent', archetype, role: t.role },
        owner_id: agentFor.get(agentKey)!,
        acceptance_criteria: t.acceptance_criteria,
        depends_on: t.depends_on.map(resolve),
        verifies: t.verifies.map(resolve),
        input_keys: t.input_keys,
        params: t.params,
        required_outputs: t.outputs,
        verification: t.verification,
        authority: { ...authority, write_scope: t.write_scope.length ? t.write_scope : [] },
        reservation: scaleAmounts(basis, t.budget_share),
        budget_class: t.budget_class,
        risk_tier: t.risk_tier,
        competing_group: t.competing_group,
      });
      idOf.set(t.ref, task.id);
      tasks.push(task);
    }
    if (pending.length) throw new SwarmError('invalid_plan', `Plan has unresolved references: ${pending.map((p) => p.ref).join(', ')}`);

    for (const x of plan.extra_dependencies) {
      const target = store.tasks.first('"mission_id" = ? AND "key" = ?', mission.id, x.task_key)!;
      for (const d of x.depends_on) kernel.addDependency(target.id, resolve(d), 'prerequisite');
    }
    store.emit({ type: 'plan_materialized', mission_id: mission.id, task_id: proposer?.id ?? null, actor_id: proposer?.owner_id ?? 'mission-coordination', actor_kind: 'agent', payload: { topology: plan.topology, anchor: plan.anchor, teams: swarms.map((s) => s.archetype), tasks: tasks.map((t) => t.key), interface_agreements: plan.interface_agreements.map((a) => a.artifact_key), rationale: plan.rationale }, release_id: mission.release_id });
    return { swarms, tasks };
  });
}
