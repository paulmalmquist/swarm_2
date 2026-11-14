import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type {
  AcceptanceCriterion,
  ActorKind,
  Agent,
  ArtifactKind,
  ArtifactVersion,
  Attempt,
  AttemptStatus,
  AuthorityEnvelope,
  BudgetClass,
  Command,
  DataClass,
  DelegationContract,
  InputRef,
  Iso,
  LimitsProfile,
  Mission,
  NextAction,
  Observation,
  ProviderMode,
  ResourceAmounts,
  RiskTier,
  SourceLabel,
  Swarm,
  SwarmArchetype,
  Task,
  TaskExecutor,
  UsageRecord,
  Verification,
  VerificationKind,
  WorkOutput,
} from '../contracts/types.ts';
import { OUTWARD_ACTIONS } from '../contracts/types.ts';
import type { Store } from '../store/store.ts';
import { Budget } from './budget.ts';
import { SwarmError, amounts, assert, coveredBy, hashOf, isoPlus, newId, pidAlive, scaleAmounts, sha256, truncate } from '../lib/util.ts';

/** Fencing token: a write is accepted only if it carries the task's current attempt and generation. */
export interface Token {
  attempt: number;
  generation: number;
}

export function tokenString(t: Token): string {
  return `g${t.generation}a${t.attempt}`;
}

export function parseToken(s: string): Token {
  const m = /^g(\d+)a(\d+)$/.exec(s);
  if (!m) throw new SwarmError('bad_token', `Malformed fencing token: ${s}`);
  return { generation: Number(m[1]), attempt: Number(m[2]) };
}

export interface NewMission {
  title: string;
  objective: string;
  priority: number;
  requested_by: string;
  accountable_human: string;
  authorization: AuthorityEnvelope;
  budget: ResourceAmounts;
  data_class: DataClass;
  provider_mode: ProviderMode;
  scenario: string | null;
  request_ids: string[];
  release_id: string;
}

export interface NewTask {
  mission_id: string;
  parent_task_id: string | null;
  swarm_id: string | null;
  key: string;
  title: string;
  objective: string;
  executor: TaskExecutor;
  assignee: { kind: 'agent' | 'swarm'; archetype: SwarmArchetype; role: string };
  owner_id: string;
  acceptance_criteria: AcceptanceCriterion[];
  depends_on: string[];
  /** Tasks whose submitted result this task verifies (it becomes ready when they are submitted). */
  verifies?: string[];
  input_keys: string[];
  params?: Record<string, unknown>;
  required_outputs: { key: string; kind: ArtifactKind; description: string }[];
  verification: { method: 'executable' | 'independent_review' | 'both' | 'none'; independent: boolean };
  authority: AuthorityEnvelope;
  reservation: ResourceAmounts;
  budget_class: BudgetClass;
  deadline?: Iso | null;
  stopping_conditions?: string[];
  risk_tier?: RiskTier;
  competing_group?: string | null;
  priority?: number;
  scope_signature?: string | null;
}

export interface Impact {
  task_id: string;
  key: string;
  action: 'rerun_required' | 'fenced_in_flight' | 'downstream_blocked';
  reason: string;
  pids: number[];
}

export interface PublishInput {
  mission_id: string;
  key: string;
  kind: ArtifactKind;
  media_type: string;
  content?: string;
  /** For code: a git commit and its tree hash stand in for the content. */
  git?: { commit: string; tree: string };
  produced_by_task_id: string | null;
  produced_by_attempt: number | null;
  inputs: InputRef[];
  release_id: string | null;
  source: SourceLabel;
}

const TERMINAL: Task['status'][] = ['accepted', 'failed', 'cancelled', 'not_selected'];

/**
 * Whether an attempt ran a model client. In a live mission some attempts do not: steps the runtime
 * executes itself, steps a scenario keeps scripted, and verified results that are reused.
 */
export function ranAModel(a: Pick<Attempt, 'provider' | 'provider_mode'>): boolean {
  return a.provider_mode === 'live' && !['runtime', 'fixture', 'reuse'].includes(a.provider);
}

export class Kernel {
  store: Store;
  limits: LimitsProfile;
  budget: Budget;
  artifactDir: string;

  constructor(store: Store, limits: LimitsProfile, artifactDir: string) {
    this.store = store;
    this.limits = limits;
    this.budget = new Budget(store);
    this.artifactDir = artifactDir;
    mkdirSync(artifactDir, { recursive: true });
  }

  private get clock() {
    return this.store.clock;
  }

  // ───────────────────────────── authority ─────────────────────────────

  /** A child may only hold a subset of its parent's authority, and never an outward action. */
  assertNarrower(child: AuthorityEnvelope, parent: AuthorityEnvelope, who: string): void {
    for (const dim of ['tools', 'data', 'actions', 'write_scope'] as const) {
      const extra = coveredBy(child[dim], parent[dim]);
      assert(extra === null, 'authority_widening', `${who} requests ${dim} "${extra}" which its parent does not hold`, { dim, extra });
    }
    const dropped = parent.forbidden_actions.find((f) => !child.forbidden_actions.includes(f));
    assert(!dropped, 'authority_widening', `${who} drops the forbidden action "${dropped}"`, { dropped });
    const outward = child.actions.find((a) => (OUTWARD_ACTIONS as readonly string[]).includes(a));
    assert(!outward, 'outward_action_not_delegable', `${who} requests "${outward}", which is routed to the chief of staff`, { outward });
  }

  // ───────────────────────────── missions ─────────────────────────────

  createMission(cmd: Command<NewMission>): Mission {
    return this.store.idempotent(cmd.key, 'createMission', cmd.data, () => {
      const m = cmd.data;
      const outward = m.authorization.actions.find((a) => (OUTWARD_ACTIONS as readonly string[]).includes(a));
      assert(!outward, 'outward_action_not_delegable', `Mission authorization may not include "${outward}"`, { outward });
      const id = newId('msn');
      const root = this.budget.openRoot(id, `mission:${id}`, m.budget);
      // Hold back capacity so delivery cannot exhaust what is needed to verify, recover and finish.
      const r = this.limits.reserve;
      const share = { verification: r.verification, recovery: r.recovery, completion: r.completion, exploration: this.limits.exploration_share };
      const delivery = 1 - share.verification - share.recovery - share.completion - share.exploration;
      assert(delivery > 0, 'bad_limits', 'Reserve shares leave nothing for delivery');
      const classes: Record<string, string> = {};
      for (const [cls, f] of Object.entries({ ...share, delivery })) {
        classes[cls] = this.budget.reserve(root.id, `mission:${id}:${cls}`, cls as BudgetClass, scaleAmounts(m.budget, f)).id;
      }
      const now = this.clock.iso();
      const mission: Mission = {
        id,
        title: m.title,
        objective: m.objective,
        status: 'planning',
        priority: m.priority,
        requested_by: m.requested_by,
        accountable_human: m.accountable_human,
        authorization: m.authorization,
        budget_account_id: root.id,
        release_id: m.release_id,
        data_class: m.data_class,
        provider_mode: m.provider_mode,
        scenario: m.scenario,
        request_ids: m.request_ids,
        root_task_id: null,
        created_at: now,
        updated_at: now,
        revision: 1,
        cancel_reason: null,
        migration: null,
      };
      this.store.missions.put(mission);
      this.store.setMeta(`mission:${id}:classes`, classes);
      this.store.emit({ type: 'mission_submitted', mission_id: id, actor_id: cmd.actor, actor_kind: 'chief_of_staff', payload: { title: m.title, priority: m.priority, release_id: m.release_id, provider_mode: m.provider_mode, data_class: m.data_class }, idempotency_key: cmd.key, release_id: m.release_id });
      return mission;
    }).result;
  }

  classAccount(mission_id: string, cls: BudgetClass): string {
    const classes = this.store.getMeta<Record<string, string>>(`mission:${mission_id}:classes`);
    const id = classes?.[cls];
    assert(id, 'no_budget_class', `Mission ${mission_id} has no ${cls} budget`);
    return id;
  }

  setMissionStatus(mission_id: string, status: Mission['status'], actor = 'runtime', payload: Record<string, unknown> = {}): Mission {
    return this.store.db.tx(() => {
      const m = this.store.missions.must(mission_id);
      if (m.status === status) return m;
      const from = m.status;
      m.status = status;
      m.updated_at = this.clock.iso();
      m.revision++;
      this.store.missions.put(m);
      this.store.emit({ type: 'mission_status_changed', mission_id, actor_id: actor, actor_kind: 'runtime', payload: { from, to: status, ...payload }, release_id: m.release_id });
      return m;
    });
  }

  /**
   * A person sends failed work back for one more repair, with guidance. Agents cannot do this:
   * the repair limit is a ceiling for them, and only a human decision lifts it, once.
   */
  reviveTask(task_id: string, actor: string, guidance: string): Task {
    return this.store.db.tx(() => {
      const task = this.store.tasks.must(task_id);
      assert(task.status === 'failed', 'bad_transition', `Only failed work can be sent back by a person; ${task.key} is ${task.status}`, { status: task.status });
      const prior = this.store.getMeta<{ reason: string }>(`task:${task.id}:rework`);
      task.status = 'ready';
      task.blocked_reason = null;
      task.repairs = Math.max(0, this.limits.max_repair_attempts - 1);
      task.retries = 0;
      this.store.setMeta(`task:${task.id}:rework`, { reason: truncate(`A person reviewed the failure and gave this guidance: ${guidance}. The last rejection was: ${prior?.reason ?? 'not recorded'}`, 1600), failure_class: 'human_guidance', repairs: task.repairs, at: this.clock.iso() });
      this.touch(task, this.nextAction(task.owner_id, 'agent', `Repair with guidance: ${task.title}`));
      // Teams that settled as failed because of this task are working again, with their budgets.
      let parent = task.parent_task_id ? this.store.tasks.get(task.parent_task_id) : undefined;
      while (parent) {
        if (parent.status === 'failed' || parent.status === 'accepted') {
          const from = parent.status;
          parent.status = 'active';
          this.touch(parent, null);
          this.budget.reopen(parent.budget_account_id);
          const swarm = parent.swarm_id ? this.store.swarms.get(parent.swarm_id) : undefined;
          if (swarm && swarm.status !== 'active') this.store.swarms.put({ ...swarm, status: 'active' });
          this.store.emit({ type: 'task_status_changed', mission_id: parent.mission_id, task_id: parent.id, actor_id: actor, actor_kind: 'human', payload: { key: parent.key, from, to: 'active', reopened_by: task.key } });
        }
        parent = parent.parent_task_id ? this.store.tasks.get(parent.parent_task_id) : undefined;
      }
      this.store.emit({ type: 'task_revived', mission_id: task.mission_id, task_id, actor_id: actor, actor_kind: 'human', payload: { key: task.key, guidance: truncate(guidance, 400), repairs_left: this.limits.max_repair_attempts - task.repairs }, release_id: task.contract.release_id });
      return task;
    });
  }

  /** Whether a submission published a version of every output the contract requires. */
  private deliveredEverything(task: Task, version_ids: string[]): boolean {
    if (task.contract.required_outputs.length === 0) return false;
    const keys = new Set(version_ids.map((id) => this.store.versions.get(id)?.key));
    return task.contract.required_outputs.every((o) => keys.has(o.key));
  }

  /**
   * How long a mission has actually been running: time spent in `planning` or `active`.
   * Time spent waiting for a person (blocked, review) does not count. Computed from the event
   * log, so it survives restarts.
   */
  runningMs(mission_id: string): number {
    const m = this.store.missions.must(mission_id);
    const running = (s: string): boolean => s === 'planning' || s === 'active';
    let total = 0;
    let since: number | null = Date.parse(m.created_at);
    for (const e of this.store.events({ mission_id, type: 'mission_status_changed', limit: 10_000 })) {
      const at = Date.parse(e.ts);
      const to = String(e.payload.to);
      if (since !== null && !running(to)) {
        total += at - since;
        since = null;
      } else if (since === null && running(to)) {
        since = at;
      }
    }
    if (since !== null && running(m.status)) total += this.clock.now() - since;
    return total;
  }

  /** The wall-clock ceiling for a mission: operator configuration plus any extension a person granted. */
  wallLimitMs(mission_id: string): number {
    return this.limits.max_wall_ms + (this.store.getMeta<number>(`mission:${mission_id}:wall_extension_ms`) ?? 0);
  }

  changePriority(cmd: Command<{ mission_id: string; priority: number }>): Mission {
    return this.store.idempotent(cmd.key, 'changePriority', cmd.data, () => {
      const m = this.store.missions.must(cmd.data.mission_id);
      if (cmd.expected_version != null) assert(m.revision === cmd.expected_version, 'stale_revision', `Mission is at revision ${m.revision}`, { current: m.revision });
      const from = m.priority;
      m.priority = cmd.data.priority;
      m.updated_at = this.clock.iso();
      m.revision++;
      this.store.missions.put(m);
      for (const t of this.store.tasks.where('"mission_id" = ?', m.id)) {
        if (TERMINAL.includes(t.status)) continue;
        t.priority = cmd.data.priority;
        this.store.tasks.put(t);
      }
      this.store.emit({ type: 'mission_priority_changed', mission_id: m.id, actor_id: cmd.actor, actor_kind: 'chief_of_staff', payload: { from, to: m.priority }, idempotency_key: cmd.key });
      return m;
    }).result;
  }

  // ───────────────────────────── organization ─────────────────────────────

  createSwarm(input: Omit<Swarm, 'id' | 'created_at' | 'status' | 'depth'> & { depth?: number }): Swarm {
    // Every team needs a bounded purpose, an owner, a budget, a deliverable and a stopping condition.
    for (const f of ['purpose', 'lead_agent_id', 'deliverable', 'stopping_condition', 'budget_account_id'] as const) {
      assert(String(input[f] ?? '').trim().length > 0, 'unbounded_team', `A team needs a ${f.replace(/_/g, ' ')}`, { field: f });
    }
    const parent = input.parent_swarm_id ? this.store.swarms.must(input.parent_swarm_id) : null;
    const depth = input.depth ?? (parent ? parent.depth + 1 : 1);
    assert(depth <= this.limits.max_delegation_depth, 'depth_exceeded', `Delegation depth ${depth} exceeds the limit of ${this.limits.max_delegation_depth}`, { depth });
    const swarm: Swarm = { ...input, id: newId('swm'), status: 'active', depth, created_at: this.clock.iso() };
    this.store.swarms.put(swarm);
    this.store.emit({ type: 'swarm_formed', mission_id: swarm.mission_id, actor_id: input.lead_agent_id, actor_kind: 'agent', payload: { swarm_id: swarm.id, archetype: swarm.archetype, purpose: swarm.purpose, parent_swarm_id: swarm.parent_swarm_id, temporary: swarm.temporary, depth } });
    return swarm;
  }

  createAgent(input: Omit<Agent, 'id' | 'created_at' | 'status'>): Agent {
    const agent: Agent = { ...input, id: newId('agt'), status: 'active', created_at: this.clock.iso() };
    this.store.agents.put(agent);
    return agent;
  }

  // ───────────────────────────── tasks ─────────────────────────────

  createTask(n: NewTask, actor = 'runtime'): Task {
    return this.store.db.tx(() => {
      const mission = this.store.missions.must(n.mission_id);
      assert(!['cancelled', 'completed', 'failed'].includes(mission.status), 'mission_closed', `Mission ${mission.id} is ${mission.status}`);
      assert(!this.store.tasks.first('"mission_id" = ? AND "key" = ?', n.mission_id, n.key), 'duplicate_task_key', `Task key ${n.key} already exists in this mission`, { key: n.key });
      const parent = n.parent_task_id ? this.store.tasks.must(n.parent_task_id) : null;
      const depth = parent ? parent.depth + 1 : 1;
      assert(depth <= this.limits.max_delegation_depth, 'depth_exceeded', `Delegation depth ${depth} exceeds the limit of ${this.limits.max_delegation_depth}`, { depth, key: n.key });
      this.assertNarrower(n.authority, parent ? parent.contract.authority : mission.authorization, `task ${n.key}`);
      if (n.executor !== 'container') {
        assert(n.acceptance_criteria.length > 0 || n.verification.method === 'none', 'no_acceptance_criteria', `Task ${n.key} has no acceptance criteria`);
      }
      for (const dep of n.depends_on) assert(this.store.tasks.get(dep), 'unknown_dependency', `Task ${n.key} depends on unknown task ${dep}`);

      // Children consume their parent's budget; a sibling class account is used at the top level.
      const budgetParent = parent ? parent.budget_account_id : this.classAccount(n.mission_id, n.budget_class);
      const id = newId('tsk');
      const account = this.budget.reserve(budgetParent, `task:${n.key}`, 'task', n.reservation);

      const contract: DelegationContract = {
        contract_version: 1,
        mission_id: n.mission_id,
        task_id: id,
        parent_task_id: n.parent_task_id,
        assignee: n.assignee,
        owner_id: n.owner_id,
        accountable_human: mission.accountable_human,
        title: n.title,
        objective: n.objective,
        acceptance_criteria: n.acceptance_criteria,
        inputs: [],
        dependencies: n.depends_on,
        assumptions: [],
        authority: n.authority,
        resources: { reservation: n.reservation, deadline: n.deadline ?? null, stopping_conditions: n.stopping_conditions ?? [] },
        required_outputs: n.required_outputs,
        verification: n.verification,
        escalation: { path: this.escalationPath(parent, mission), after_ms: null },
        cancellation: { propagate: true, preserve_artifacts: true, grace_ms: 2000 },
        risk_tier: n.risk_tier ?? 'low',
        release_id: mission.release_id,
      };
      const now = this.clock.iso();
      const task: Task = {
        id,
        mission_id: n.mission_id,
        parent_task_id: n.parent_task_id,
        swarm_id: n.swarm_id,
        key: n.key,
        title: n.title,
        executor: n.executor,
        status: 'planned',
        owner_id: n.owner_id,
        contract,
        contract_hash: hashOf(contract),
        attempt: 0,
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        depth,
        priority: n.priority ?? mission.priority,
        currency: 'current',
        generation: 1,
        retries: 0,
        repairs: 0,
        budget_account_id: account.id,
        blocked_reason: null,
        next_action: null,
        competing_group: n.competing_group ?? null,
        scope_signature: n.scope_signature ?? null,
        created_at: now,
        updated_at: now,
        revision: 1,
      };
      this.store.tasks.put(task);
      this.store.setMeta(`task:${id}:input_keys`, n.input_keys);
      this.store.setMeta(`task:${id}:params`, n.params ?? {});
      for (const dep of n.depends_on) this.addDependency(id, dep, 'prerequisite');
      for (const target of n.verifies ?? []) {
        assert(this.store.tasks.get(target), 'unknown_dependency', `Task ${n.key} verifies unknown task ${target}`);
        this.addDependency(id, target, 'verifies');
      }
      this.store.emit({ type: 'task_created', mission_id: n.mission_id, task_id: id, actor_id: actor, actor_kind: 'runtime', payload: { key: n.key, executor: n.executor, owner_id: n.owner_id, depth, depends_on: n.depends_on, reservation: n.reservation, archetype: n.assignee.archetype }, release_id: mission.release_id });
      return task;
    });
  }

  private escalationPath(parent: Task | null, mission: Mission): string[] {
    const path: string[] = [];
    let p = parent;
    while (p) {
      path.push(p.owner_id);
      p = p.parent_task_id ? this.store.tasks.must(p.parent_task_id) : null;
    }
    path.push('chief_of_staff', mission.accountable_human);
    return [...new Set(path)];
  }

  /** Add a prerequisite edge. Rejects anything that would close a cycle. */
  addDependency(task_id: string, depends_on: string, kind: 'prerequisite' | 'verifies'): void {
    assert(task_id !== depends_on, 'dependency_cycle', 'A task cannot depend on itself', { task_id });
    assert(!this.reaches(depends_on, task_id), 'dependency_cycle', `Adding ${task_id} → ${depends_on} would create a cycle`, { task_id, depends_on });
    this.store.db.run('INSERT OR IGNORE INTO task_deps (task_id, depends_on, kind) VALUES (?, ?, ?)', task_id, depends_on, kind);
  }

  private reaches(from: string, target: string): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const r of this.store.db.all<{ depends_on: string }>('SELECT depends_on FROM task_deps WHERE task_id = ?', cur)) stack.push(r.depends_on);
    }
    return false;
  }

  /** Prerequisites: tasks that must be accepted before this one may start. */
  dependenciesOf(task_id: string): string[] {
    return this.store.db.all<{ depends_on: string }>(`SELECT depends_on FROM task_deps WHERE task_id = ? AND kind = 'prerequisite'`, task_id).map((r) => r.depends_on);
  }

  dependentsOf(task_id: string): string[] {
    return this.store.db.all<{ task_id: string }>(`SELECT task_id FROM task_deps WHERE depends_on = ? AND kind = 'prerequisite'`, task_id).map((r) => r.task_id);
  }

  /** Tasks whose submitted result `task_id` verifies. */
  verificationTargets(task_id: string): string[] {
    return this.store.db.all<{ depends_on: string }>(`SELECT depends_on FROM task_deps WHERE task_id = ? AND kind = 'verifies'`, task_id).map((r) => r.depends_on);
  }

  verifiersOf(task_id: string): string[] {
    return this.store.db.all<{ task_id: string }>(`SELECT task_id FROM task_deps WHERE depends_on = ? AND kind = 'verifies'`, task_id).map((r) => r.task_id);
  }

  params(task_id: string): Record<string, unknown> {
    return this.store.getMeta<Record<string, unknown>>(`task:${task_id}:params`) ?? {};
  }

  inputKeys(task_id: string): string[] {
    return this.store.getMeta<string[]>(`task:${task_id}:input_keys`) ?? [];
  }

  private touch(task: Task, next?: NextAction | null): Task {
    task.updated_at = this.clock.iso();
    task.revision++;
    if (next !== undefined) task.next_action = next;
    this.store.tasks.put(task);
    return task;
  }

  private nextAction(owner_id: string, owner_kind: ActorKind, action: string): NextAction {
    return { owner_id, owner_kind, action, since: this.clock.iso() };
  }

  /**
   * Move tasks whose prerequisites are satisfied from `planned` to `ready`, and derive the state
   * of containers from their children. Returns the tasks that became ready.
   */
  refreshReadiness(mission_id: string): Task[] {
    return this.store.db.tx(() => {
      const mission = this.store.missions.must(mission_id);
      if (['cancelled', 'failed', 'completed'].includes(mission.status)) return [];
      const tasks = this.store.tasks.where('"mission_id" = ?', mission_id).sort((a, b) => a.depth - b.depth);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const becameReady: Task[] = [];
      for (const t of tasks) {
        if (t.status !== 'planned') continue;
        const parent = t.parent_task_id ? byId.get(t.parent_task_id) : null;
        // Work inside a team starts only once the team itself has started.
        if (parent && parent.status !== 'active') continue;
        const deps = this.dependenciesOf(t.id).map((d) => byId.get(d) ?? this.store.tasks.must(d));
        const depsOk = deps.every((d) => d.status === 'accepted' && d.currency === 'current');
        const inputsOk = this.inputKeys(t.id).every((k) => this.currentVersion(mission_id, k) !== undefined);
        // A verifier starts when the work it verifies has been submitted.
        const targets = this.verificationTargets(t.id).map((d) => byId.get(d) ?? this.store.tasks.must(d));
        const targetsOk = targets.every((d) => ['submitted', 'verifying'].includes(d.status));
        if (!depsOk || !inputsOk || !targetsOk) continue;
        t.status = t.executor === 'container' ? 'active' : 'ready';
        this.touch(t, t.executor === 'container' ? null : this.nextAction(t.owner_id, 'agent', `Start: ${t.title}`));
        this.store.emit({ type: 'task_ready', mission_id, task_id: t.id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: t.key } });
        becameReady.push(t);
      }
      // Containers: accepted when every child is settled, failed if a child failed for good.
      const containers = tasks.filter((t) => t.executor === 'container' && ['active', 'planned'].includes(t.status)).sort((a, b) => b.depth - a.depth);
      for (const c of containers) {
        if (c.status !== 'active') continue;
        const kids = this.store.tasks.where('"parent_task_id" = ?', c.id);
        if (kids.length === 0 || !kids.every((k) => TERMINAL.includes(k.status))) continue;
        const failed = kids.some((k) => k.status === 'failed');
        const anyAccepted = kids.some((k) => k.status === 'accepted');
        c.status = failed ? 'failed' : anyAccepted ? 'accepted' : 'cancelled';
        if (c.status === 'accepted') c.currency = 'current';
        this.touch(c, null);
        this.budget.close(c.budget_account_id);
        if (c.swarm_id) {
          const s = this.store.swarms.get(c.swarm_id);
          if (s && s.status === 'active') {
            s.status = s.temporary ? 'disbanded' : 'completed';
            this.store.swarms.put(s);
            this.store.emit({ type: s.temporary ? 'swarm_disbanded' : 'swarm_completed', mission_id, actor_id: 'runtime', actor_kind: 'runtime', payload: { swarm_id: s.id, archetype: s.archetype } });
          }
        }
        this.store.emit({ type: 'task_status_changed', mission_id, task_id: c.id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: c.key, to: c.status, derived_from_children: true } });
      }
      return becameReady;
    });
  }

  // ───────────────────────────── leases and fencing ─────────────────────────────

  activeCalls(): number {
    return Number(this.store.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM active_calls')?.n ?? 0);
  }

  /**
   * Atomically lease a ready task to one owner. Returns null when capacity is not available
   * (that is back-pressure, not an error). Each lease increments the fencing epoch.
   */
  claim(task_id: string, agent_id: string, opts: { provider: string; provider_mode: ProviderMode; model_requested: string | null; uses_call_slot: boolean }): { task: Task; attempt: Attempt; token: Token } | null {
    return this.store.db.tx(() => {
      const task = this.store.tasks.must(task_id);
      if (task.status !== 'ready') return null;
      const mission = this.store.missions.must(task.mission_id);
      if (!['planning', 'active'].includes(mission.status)) return null;
      if (opts.uses_call_slot && this.activeCalls() >= this.limits.max_concurrent_model_calls) return null;

      const invocations = this.store.attempts.count(`"mission_id" = ? AND "provider" != 'runtime'`, task.mission_id);
      if (opts.provider !== 'runtime' && invocations >= this.limits.max_worker_invocations) {
        this.block(task, 'invocation_cap', this.nextAction('chief_of_staff', 'chief_of_staff', `Raise the worker invocation cap or cancel: ${task.title}`));
        return null;
      }
      if (!this.ensureOpenAccount(task)) {
        this.block(task, 'budget_exhausted', this.nextAction('chief_of_staff', 'chief_of_staff', `No budget left to redo: ${task.title}`));
        return null;
      }
      // Each attempt needs at least one worker invocation of budget; a retry may draw on the recovery reserve.
      const need = amounts({ worker_invocations: 1, model_calls: opts.uses_call_slot ? 1 : 0 });
      const have = this.budget.available(task.budget_account_id);
      if (have.worker_invocations < need.worker_invocations || have.model_calls < need.model_calls) {
        if (!this.topUpFromRecovery(task)) {
          this.block(task, 'budget_exhausted', this.nextAction('chief_of_staff', 'chief_of_staff', `Budget exhausted for: ${task.title}`));
          return null;
        }
      }

      // Pin exact input versions for this attempt.
      const inputs: InputRef[] = [];
      this.store.db.run('DELETE FROM task_inputs WHERE task_id = ?', task.id);
      for (const key of this.inputKeys(task.id)) {
        const v = this.currentVersion(task.mission_id, key);
        if (!v) return null;
        inputs.push({ artifact_key: key, version_id: v.id, content_hash: v.content_hash, relation: 'uses' });
        this.store.db.run('INSERT INTO task_inputs (task_id, artifact_key, version_id) VALUES (?, ?, ?)', task.id, key, v.id);
      }
      task.contract.inputs = inputs;
      task.contract_hash = hashOf(task.contract);

      task.attempt += 1;
      task.status = 'leased';
      task.lease_owner = agent_id;
      task.lease_expires_at = isoPlus(this.clock, this.limits.lease_ms);
      task.heartbeat_at = this.clock.iso();
      task.currency = 'current';
      this.touch(task, this.nextAction(agent_id, 'agent', `Working: ${task.title}`));

      const attempt: Attempt = {
        id: newId('att'),
        task_id: task.id,
        mission_id: task.mission_id,
        attempt_no: task.attempt,
        agent_id,
        provider: opts.provider,
        provider_mode: opts.provider_mode,
        pid: null,
        session_id: null,
        status: 'running',
        model_requested: opts.model_requested,
        model_actual: null,
        usage: null,
        error: null,
        workspace: null,
        release_id: mission.release_id,
        generation: task.generation,
        started_at: this.clock.iso(),
        ended_at: null,
      };
      this.store.attempts.put(attempt);
      if (opts.uses_call_slot) this.store.db.run('INSERT INTO active_calls (attempt_id, mission_id, started_at) VALUES (?, ?, ?)', attempt.id, task.mission_id, attempt.started_at);
      if (mission.status === 'planning') this.setMissionStatus(mission.id, 'active');
      const token = { attempt: task.attempt, generation: task.generation };
      this.store.emit({ type: 'task_leased', mission_id: task.mission_id, task_id: task.id, actor_id: agent_id, actor_kind: 'agent', payload: { key: task.key, token: tokenString(token), attempt_id: attempt.id, provider: opts.provider, provider_mode: opts.provider_mode, inputs: inputs.map((i) => ({ key: i.artifact_key, version_id: i.version_id })) }, release_id: mission.release_id });
      return { task, attempt, token };
    });
  }

  /** Settled work that must be redone needs a fresh reservation: from its parent if it fits, else from the recovery reserve. */
  private ensureOpenAccount(task: Task): boolean {
    const acct = this.store.accounts.must(task.budget_account_id);
    if (acct.status === 'open') return true;
    // First choice: reopen the task's own account with whatever it had not spent.
    if (this.budget.reopen(acct.id)) {
      this.store.emit({ type: 'budget_reopened', mission_id: task.mission_id, task_id: task.id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: task.key, available: this.budget.available(acct.id) } });
      return true;
    }
    // Otherwise a small reservation from the recovery reserve: enough for a couple of attempts.
    const want = task.contract.resources.reservation;
    const small = amounts({ worker_invocations: 2, model_calls: 2, tokens: Math.floor(want.tokens / 4), cost_usd_est: want.cost_usd_est / 4, wall_ms: want.wall_ms });
    try {
      task.budget_account_id = this.budget.reserve(this.classAccount(task.mission_id, 'recovery'), `redo:${task.key}:g${task.generation}`, 'task', small).id;
      // Stored at once: if this claim goes no further, the reservation must not be left without an owner.
      this.store.tasks.put(task);
      this.store.emit({ type: 'recovery_reserve_used', mission_id: task.mission_id, task_id: task.id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: task.key, amount: small } });
      return true;
    } catch (err) {
      if (!(err instanceof SwarmError) || !['budget_exceeded', 'budget_closed'].includes(err.code)) throw err;
      return false;
    }
  }

  /**
   * A retry the task's own account cannot pay for draws on the recovery reserve. The allowance is
   * moved, not spent: the reserve narrows, the task and the teams above it widen by the same
   * amount, and nothing counts as consumed until an attempt reports what it used. Booking the
   * move as consumption would make a mission's spend include allowance nobody used.
   */
  private topUpFromRecovery(task: Task): boolean {
    const want = task.contract.resources.reservation;
    const extra = amounts({ worker_invocations: 1, model_calls: 1, tokens: Math.floor(want.tokens / 2), cost_usd_est: want.cost_usd_est / 2, wall_ms: want.wall_ms });
    if (!this.budget.transfer(this.classAccount(task.mission_id, 'recovery'), task.budget_account_id, extra, `recovery:${task.key}:a${task.attempt + 1}`)) return false;
    this.store.emit({ type: 'recovery_reserve_used', mission_id: task.mission_id, task_id: task.id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: task.key, amount: extra } });
    return true;
  }

  /** A settled team is reopened when one of its members has work to do again. */
  private reopenAncestors(task: Task): void {
    let parent = task.parent_task_id ? this.store.tasks.get(task.parent_task_id) : undefined;
    while (parent) {
      if (parent.status === 'accepted') {
        parent.status = 'active';
        this.touch(parent, null);
        this.store.emit({ type: 'task_status_changed', mission_id: parent.mission_id, task_id: parent.id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: parent.key, from: 'accepted', to: 'active', reopened_by: task.key } });
      }
      parent = parent.parent_task_id ? this.store.tasks.get(parent.parent_task_id) : undefined;
    }
  }

  private currentToken(task: Task): Token {
    return { attempt: task.attempt, generation: task.generation };
  }

  private tokenValid(task: Task, token: Token): boolean {
    return task.status === 'leased' && task.attempt === token.attempt && task.generation === token.generation;
  }

  attemptFor(task_id: string, attempt_no: number): Attempt | undefined {
    return this.store.attempts.first('"task_id" = ? AND "attempt_no" = ?', task_id, attempt_no);
  }

  /** Extend the lease. Returns false when the caller no longer owns the task. */
  heartbeat(task_id: string, token: Token, info: { pid?: number; session_id?: string; workspace?: Attempt['workspace'] } = {}): boolean {
    return this.store.db.tx(() => {
      const task = this.store.tasks.must(task_id);
      if (!this.tokenValid(task, token)) return false;
      task.heartbeat_at = this.clock.iso();
      task.lease_expires_at = isoPlus(this.clock, this.limits.lease_ms);
      this.store.tasks.put(task);
      if (info.pid !== undefined || info.session_id !== undefined || info.workspace !== undefined) {
        const a = this.attemptFor(task_id, token.attempt);
        if (a) {
          if (info.pid !== undefined) a.pid = info.pid;
          if (info.session_id !== undefined) a.session_id = info.session_id;
          if (info.workspace !== undefined) a.workspace = info.workspace;
          this.store.attempts.put(a);
        }
      }
      return true;
    });
  }

  /**
   * Model attempts that ended without a complete usage report: a worker stopped at its deadline,
   * fenced or cancelled never says what it used. While this is above zero, a mission's token and
   * cost totals are lower bounds. An attempt refused for lack of capacity made no call and is not counted.
   */
  unreportedUsage(mission_id: string): number {
    return this.store.attempts
      .where('"mission_id" = ?', mission_id)
      .filter((a) => ranAModel(a) && a.ended_at !== null && a.status !== 'rate_limited' && (!a.usage || a.usage.completeness !== 'complete')).length;
  }

  private usageAmounts(usage: UsageRecord | null): ResourceAmounts {
    if (!usage) return amounts({ worker_invocations: 1 });
    return amounts({
      model_calls: usage.call_count,
      worker_invocations: 1,
      tokens: (usage.input_units ?? 0) + (usage.output_units ?? 0),
      cost_usd_est: usage.reported_cost ?? 0,
      wall_ms: usage.wall_ms,
    });
  }

  private endAttempt(task: Task, attempt_no: number, status: AttemptStatus, usage: UsageRecord | null, extra: Partial<Attempt> = {}): Attempt | undefined {
    const a = this.attemptFor(task.id, attempt_no);
    if (!a) return undefined;
    const wasRunning = a.status === 'running';
    a.status = status;
    a.ended_at = this.clock.iso();
    if (usage) a.usage = usage;
    Object.assign(a, extra);
    this.store.attempts.put(a);
    this.store.db.run('DELETE FROM active_calls WHERE attempt_id = ?', a.id);
    if (wasRunning || usage) {
      const r = this.budget.consume(task.budget_account_id, this.usageAmounts(usage), `attempt:${a.id}`);
      if (r.over) this.store.emit({ type: 'budget_overrun', mission_id: task.mission_id, task_id: task.id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: task.key, shortfall: r.shortfall } });
    }
    return a;
  }

  /**
   * Accept a worker's result. A result carrying a stale token is rejected and recorded;
   * it can never overwrite a newer attempt.
   */
  submitResult(
    task_id: string,
    token: Token,
    output: WorkOutput,
    usage: UsageRecord | null,
    extra: { model_actual?: string | null; session_id?: string | null; workspace?: Attempt['workspace']; git?: { commit: string; tree: string; key: string } | null; source: SourceLabel; key?: string },
  ): { accepted: boolean; reason: string | null; task: Task; impacts: Impact[]; version_ids: string[] } {
    const run = () =>
      this.store.db.tx(() => {
        const task = this.store.tasks.must(task_id);
        if (!this.tokenValid(task, token)) {
          const reason = task.status !== 'leased' ? `task is ${task.status}` : `current token is ${tokenString(this.currentToken(task))}`;
          const old = this.attemptFor(task_id, token.attempt);
          if (old && old.status === 'running') {
            old.status = 'superseded';
            old.ended_at = this.clock.iso();
            this.store.attempts.put(old);
            this.store.db.run('DELETE FROM active_calls WHERE attempt_id = ?', old.id);
          }
          this.store.emit({ type: 'stale_result_rejected', mission_id: task.mission_id, task_id, actor_id: old?.agent_id ?? 'unknown', actor_kind: 'agent', payload: { key: task.key, presented: tokenString(token), reason } });
          return { accepted: false, reason, task, impacts: [] as Impact[], version_ids: [] as string[] };
        }
        const attempt = this.endAttempt(task, token.attempt, output.status === 'failed' ? 'failed' : 'succeeded', usage, {
          model_actual: extra.model_actual ?? null,
          session_id: extra.session_id ?? null,
          ...(extra.workspace ? { workspace: extra.workspace } : {}),
        });
        const agent = attempt?.agent_id ?? task.owner_id;

        const impacts: Impact[] = [];
        const version_ids: string[] = [];
        const publish = (p: Omit<PublishInput, 'mission_id' | 'produced_by_task_id' | 'produced_by_attempt' | 'inputs' | 'release_id' | 'source'>) => {
          const r = this.publishVersion({ ...p, mission_id: task.mission_id, produced_by_task_id: task.id, produced_by_attempt: token.attempt, inputs: task.contract.inputs, release_id: task.contract.release_id, source: extra.source });
          version_ids.push(r.version.id);
          impacts.push(...r.impacts);
        };
        // A worker publishes only the outputs its contract names. Code is taken from git by the
        // runtime, never from what a worker says it wrote, and a file is read only if it is a
        // regular file inside the worker's own workspace.
        const named = new Set(task.contract.required_outputs.map((o) => o.key));
        const fromGit = new Set(task.contract.required_outputs.filter((o) => o.kind === 'code').map((o) => o.key));
        const ignored: { key: string; why: string }[] = [];
        for (const art of output.artifacts) {
          if (!named.has(art.key)) {
            ignored.push({ key: art.key, why: 'not an output named in the contract' });
            continue;
          }
          if (fromGit.has(art.key)) {
            ignored.push({ key: art.key, why: 'code is recorded from the workspace commit' });
            continue;
          }
          let content = art.content;
          if (content === undefined && art.path && extra.workspace) {
            const root = resolve(extra.workspace.dir);
            const p = resolve(root, art.path);
            const regular = p.startsWith(root + sep) && existsSync(p) && lstatSync(p).isFile();
            content = regular ? readFileSync(p, 'utf8') : undefined;
          }
          if (content === undefined) {
            ignored.push({ key: art.key, why: 'no content, or its path is not a regular file inside the workspace' });
            continue;
          }
          publish({ key: art.key, kind: art.kind, media_type: art.media_type, content });
        }
        if (ignored.length) this.store.emit({ type: 'artifacts_ignored', mission_id: task.mission_id, task_id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: task.key, ignored }, release_id: task.contract.release_id });
        if (extra.git) publish({ key: extra.git.key, kind: 'code', media_type: 'application/x-git-commit', git: { commit: extra.git.commit, tree: extra.git.tree } });

        for (const ev of output.evidence) {
          this.store.evidence.put({
            id: newId('evd'),
            mission_id: task.mission_id,
            task_id: task.id,
            kind: ev.kind,
            epistemic: ev.epistemic,
            origin: ev.origin,
            evidence_class: extra.source === 'live' ? 'empirical' : 'synthetic',
            statement: truncate(ev.statement, 2000),
            canonical_ref: ev.refs[0] ?? null,
            artifact_version_id: null,
            content_hash: null,
            producer_id: agent,
            freshness_status: 'fresh',
            verification_status: 'unverified',
            observed_at: this.clock.iso(),
          });
        }
        this.store.setMeta(`task:${task.id}:output:g${task.generation}`, { summary: output.summary, criteria_claims: output.criteria_claims, remaining_uncertainty: output.remaining_uncertainty, proposals: output.proposals, questions: output.questions ?? [], plan: output.plan ?? null, version_ids, attempt_no: token.attempt });

        if (output.status === 'failed') {
          this.requeueOrFail(task, 'worker_reported_failure', output.summary);
        } else if (output.status === 'blocked' && !this.deliveredEverything(task, version_ids)) {
          this.block(task, 'worker_blocked', this.nextAction(task.contract.escalation.path[0] ?? 'chief_of_staff', 'agent', `Unblock: ${truncate(output.summary, 120)}`));
        } else {
          if (output.status === 'blocked') {
            // The worker delivered every required output but could not vouch for it. Its doubt is no
            // more a verdict than a claim would be: the work goes to verification, which decides.
            this.store.emit({ type: 'worker_doubt_recorded', mission_id: task.mission_id, task_id: task.id, actor_id: agent, actor_kind: 'agent', payload: { key: task.key, said: truncate(output.summary, 300), proceeding_to: 'verification' }, release_id: task.contract.release_id });
          }
          task.status = 'submitted';
          task.lease_owner = null;
          task.lease_expires_at = null;
          this.touch(task, this.nextAction('verification', 'runtime', `Verify: ${task.title}`));
          for (const vid of this.verifiersOf(task.id)) {
            const v = this.store.tasks.must(vid);
            if (['accepted', 'submitted', 'verifying'].includes(v.status)) {
              v.status = 'planned';
              v.generation += 1;
              this.touch(v, this.nextAction(v.owner_id, 'agent', `Verify again: ${task.title}`));
              this.reopenAncestors(v);
            }
          }
        }
        this.store.emit({ type: 'result_submitted', mission_id: task.mission_id, task_id: task.id, actor_id: agent, actor_kind: 'agent', payload: { key: task.key, token: tokenString(token), status: output.status, artifacts: output.artifacts.map((a) => a.key), version_ids, uncertainty: output.remaining_uncertainty.length, source: extra.source }, release_id: task.contract.release_id });
        return { accepted: true, reason: null, task, impacts, version_ids };
      });
    if (extra.key) return this.store.idempotent(extra.key, 'submitResult', { task_id, token, output }, run).result;
    return run();
  }

  /** Record a failed, killed, timed-out or rate-limited attempt. Stale tokens are ignored. */
  failAttempt(task_id: string, token: Token, status: AttemptStatus, error: { code: string; message: string }, usage: UsageRecord | null, opts: { countsAsRetry: boolean }): Task {
    return this.store.db.tx(() => {
      const task = this.store.tasks.must(task_id);
      if (!this.tokenValid(task, token)) {
        const old = this.attemptFor(task_id, token.attempt);
        if (old && old.status === 'running') this.endAttempt(task, token.attempt, 'superseded', usage, { error });
        return task;
      }
      this.endAttempt(task, token.attempt, status, usage, { error });
      this.store.emit({ type: 'attempt_failed', mission_id: task.mission_id, task_id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: task.key, token: tokenString(token), status, error } });
      if (status === 'rate_limited') {
        // Capacity failures must not spin and must not burn retries. No automatic fallback to another provider.
        task.status = 'ready';
        task.lease_owner = null;
        task.lease_expires_at = null;
        this.block(task, 'provider_rate_limited', this.nextAction('operator', 'operator', `Provider capacity exhausted: ${truncate(error.message, 100)}`));
        return task;
      }
      if (opts.countsAsRetry) this.requeueOrFail(task, error.code, error.message);
      else {
        task.status = 'ready';
        task.lease_owner = null;
        task.lease_expires_at = null;
        this.touch(task, this.nextAction(task.owner_id, 'agent', `Retry: ${task.title}`));
      }
      return task;
    });
  }

  private requeueOrFail(task: Task, code: string, message: string): void {
    task.retries += 1;
    task.lease_owner = null;
    task.lease_expires_at = null;
    if (task.retries > this.limits.max_retries_per_task) {
      task.status = 'failed';
      this.touch(task, this.nextAction(task.contract.escalation.path[0] ?? 'chief_of_staff', 'agent', `Decide what to do about failed task: ${task.title}`));
      this.budget.close(task.budget_account_id);
      // Not an acceptance failure: nothing was produced that a criterion could be checked against.
      this.observe({ mission_id: task.mission_id, task_id: task.id, kind: 'execution_failure', failure_class: code, certainty: 'verified', details: { message: truncate(message, 300), retries: task.retries }, component: 'execution', release_id: task.contract.release_id, source: this.sourceOf(task.mission_id) });
      this.store.emit({ type: 'task_failed', mission_id: task.mission_id, task_id: task.id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: task.key, code, retries: task.retries } });
    } else {
      task.status = 'ready';
      this.touch(task, this.nextAction(task.owner_id, 'agent', `Retry (${task.retries}/${this.limits.max_retries_per_task}): ${task.title}`));
      this.store.emit({ type: 'task_requeued', mission_id: task.mission_id, task_id: task.id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: task.key, code, retries: task.retries } });
    }
  }

  /**
   * Hand a leased or submitted task back to `planned` without counting a retry — used when a
   * prerequisite was reopened and this work has to wait for it again.
   */
  defer(task_id: string, actor: string, reason: string): Task {
    return this.store.db.tx(() => {
      const task = this.store.tasks.must(task_id);
      if (TERMINAL.includes(task.status) && task.status !== 'accepted') return task;
      if (task.status === 'leased') this.endAttempt(task, task.attempt, 'superseded', null, { error: { code: 'deferred', message: reason } });
      task.status = 'planned';
      task.generation += 1;
      task.lease_owner = null;
      task.lease_expires_at = null;
      this.touch(task, this.nextAction(task.owner_id, 'agent', `Waiting: ${truncate(reason, 100)}`));
      this.store.emit({ type: 'task_deferred', mission_id: task.mission_id, task_id, actor_id: actor, actor_kind: 'runtime', payload: { key: task.key, reason, generation: task.generation } });
      return task;
    });
  }

  block(task: Task, reason: string, next: NextAction): Task {
    if (task.status === 'leased') {
      task.lease_owner = null;
      task.lease_expires_at = null;
    }
    task.status = 'blocked';
    task.blocked_reason = reason;
    this.touch(task, next);
    this.store.emit({ type: 'task_blocked', mission_id: task.mission_id, task_id: task.id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: task.key, reason, next_owner: next.owner_id } });
    return task;
  }

  unblock(task_id: string, actor: string, why: string): Task {
    return this.store.db.tx(() => {
      const task = this.store.tasks.must(task_id);
      if (task.status !== 'blocked') return task;
      task.status = 'ready';
      const from = task.blocked_reason;
      task.blocked_reason = null;
      this.touch(task, this.nextAction(task.owner_id, 'agent', `Resume: ${task.title}`));
      this.store.emit({ type: 'task_unblocked', mission_id: task.mission_id, task_id, actor_id: actor, actor_kind: 'operator', payload: { key: task.key, was: from, why } });
      return task;
    });
  }

  /** Reclaim tasks whose lease expired. The owner is presumed lost; any late result will be fenced off. */
  expireLeases(): { task: Task; attempt: Attempt | undefined }[] {
    return this.store.db.tx(() => {
      const now = this.clock.iso();
      const expired = this.store.tasks.where(`"status" = 'leased' AND "lease_expires_at" IS NOT NULL AND "lease_expires_at" < ?`, now);
      const out: { task: Task; attempt: Attempt | undefined }[] = [];
      for (const task of expired) {
        const attempt = this.endAttempt(task, task.attempt, 'expired', null, { error: { code: 'lease_expired', message: 'No heartbeat before the lease expired' } });
        this.store.emit({ type: 'lease_expired', mission_id: task.mission_id, task_id: task.id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: task.key, token: tokenString(this.currentToken(task)), last_heartbeat: task.heartbeat_at, pid: attempt?.pid ?? null } });
        this.observe({ mission_id: task.mission_id, task_id: task.id, kind: 'stall', failure_class: 'lease_expired', certainty: 'verified', details: { attempt_no: task.attempt }, component: null, release_id: task.contract.release_id, source: this.sourceOf(task.mission_id) });
        this.requeueOrFail(task, 'lease_expired', 'worker stopped heartbeating');
        out.push({ task, attempt });
      }
      return out;
    });
  }

  // ───────────────────────────── artifacts and invalidation ─────────────────────────────

  currentVersion(mission_id: string, key: string): ArtifactVersion | undefined {
    const art = this.store.artifacts.first('"mission_id" = ? AND "key" = ?', mission_id, key);
    return art?.current_version_id ? this.store.versions.get(art.current_version_id) : undefined;
  }

  readArtifact(version: ArtifactVersion): string | null {
    if (version.content_ref.startsWith('git:')) return null;
    const p = join(this.artifactDir, version.content_ref);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  /**
   * Publish a new version of a logical artifact. Republishing identical bytes is a no-op.
   * A genuinely new version supersedes the old one and invalidates every task that consumed it.
   */
  publishVersion(p: PublishInput): { version: ArtifactVersion; created: boolean; impacts: Impact[] } {
    return this.store.db.tx(() => {
      const content_hash = p.git ? sha256(`git-tree:${p.git.tree}`) : sha256(p.content ?? '');
      let art = this.store.artifacts.first('"mission_id" = ? AND "key" = ?', p.mission_id, p.key);
      const prev = art?.current_version_id ? this.store.versions.must(art.current_version_id) : undefined;
      if (prev && prev.content_hash === content_hash && prev.currency === 'current') return { version: prev, created: false, impacts: [] };
      if (!art) {
        art = { id: newId('art'), mission_id: p.mission_id, key: p.key, kind: p.kind, current_version_id: null, created_at: this.clock.iso() };
      }
      let content_ref: string;
      let size: number;
      if (p.git) {
        content_ref = `git:${p.git.commit}`;
        size = 0;
      } else {
        const dir = join(this.artifactDir, content_hash.slice(0, 2));
        mkdirSync(dir, { recursive: true });
        content_ref = join(content_hash.slice(0, 2), content_hash);
        const full = join(this.artifactDir, content_ref);
        if (!existsSync(full)) writeFileSync(full, p.content ?? '');
        size = Buffer.byteLength(p.content ?? '');
      }
      const version: ArtifactVersion = {
        id: newId('ver'),
        artifact_id: art.id,
        mission_id: p.mission_id,
        key: p.key,
        version_no: (prev?.version_no ?? 0) + 1,
        content_hash,
        content_ref,
        media_type: p.media_type,
        size,
        produced_by_task_id: p.produced_by_task_id,
        produced_by_attempt: p.produced_by_attempt,
        input_manifest: p.inputs,
        release_id: p.release_id,
        currency: 'current',
        supersedes: prev?.id ?? null,
        source: p.source,
        created_at: this.clock.iso(),
      };
      this.store.versions.put(version);
      art.current_version_id = version.id;
      this.store.artifacts.put(art);
      if (prev) {
        prev.currency = 'superseded';
        this.store.versions.put(prev);
      }
      this.store.emit({ type: 'artifact_published', mission_id: p.mission_id, task_id: p.produced_by_task_id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: p.key, version_no: version.version_no, version_id: version.id, content_hash, supersedes: prev?.id ?? null, source: p.source }, release_id: p.release_id });
      const impacts = prev ? this.invalidateConsumers(p.mission_id, p.key, version, p.produced_by_task_id) : [];
      return { version, created: true, impacts };
    });
  }

  /**
   * An upstream artifact changed. Mark everything that consumed the old version, decide what
   * must rerun, and fence off any attempt still working against it.
   * Changed inputs mark descendants `needs_revalidation`; they are not declared wrong.
   */
  private invalidateConsumers(mission_id: string, key: string, version: ArtifactVersion, producer: string | null): Impact[] {
    const impacts: Impact[] = [];
    const seen = new Set<string>();
    const consumers = this.store.db
      .all<{ task_id: string }>('SELECT task_id FROM task_inputs WHERE artifact_key = ? AND version_id != ?', key, version.id)
      .map((r) => r.task_id)
      .filter((id) => id !== producer);
    const reason = `input ${key} changed to v${version.version_no}`;
    const directSet = new Set(consumers);
    const visit = (task_id: string, whyDownstream: string, _direct: boolean): void => {
      if (seen.has(task_id)) return;
      seen.add(task_id);
      const direct = directSet.has(task_id);
      const why = direct ? reason : whyDownstream;
      const task = this.store.tasks.get(task_id);
      if (!task || task.mission_id !== mission_id) return;
      if (['cancelled', 'failed', 'not_selected'].includes(task.status)) return;
      if (['planned', 'ready', 'blocked'].includes(task.status) && task.attempt === 0) return; // never started: will pin the new version when leased
      const pids: number[] = [];
      let action: Impact['action'];
      if (task.status === 'leased') {
        const a = this.attemptFor(task.id, task.attempt);
        if (a) {
          if (a.pid) pids.push(a.pid);
          this.endAttempt(task, task.attempt, 'superseded', null, { error: { code: 'upstream_changed', message: why } });
        }
        action = 'fenced_in_flight';
      } else {
        action = direct ? 'rerun_required' : 'downstream_blocked';
      }
      task.generation += 1;
      task.currency = 'needs_revalidation';
      task.lease_owner = null;
      task.lease_expires_at = null;
      // Direct consumers rerun as soon as their prerequisites allow; downstream work waits for them.
      task.status = 'planned';
      this.touch(task, this.nextAction(task.owner_id, 'agent', `Redo against new input: ${task.title}`));
      for (const v of this.store.versions.where('"produced_by_task_id" = ? AND "currency" = ?', task.id, 'current')) {
        v.currency = 'needs_revalidation';
        this.store.versions.put(v);
      }
      impacts.push({ task_id: task.id, key: task.key, action, reason: why, pids });
      this.store.emit({ type: 'task_invalidated', mission_id, task_id: task.id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: task.key, action, reason: why, generation: task.generation, cause_artifact: key, cause_version: version.id } });
      for (const dep of this.dependentsOf(task.id)) visit(dep, `prerequisite ${task.key} needs revalidation`, false);
      // Consumers of what this task produced are stale too.
      for (const v of this.store.versions.where('"produced_by_task_id" = ?', task.id)) {
        for (const r of this.store.db.all<{ task_id: string }>('SELECT task_id FROM task_inputs WHERE artifact_key = ?', v.key)) visit(r.task_id, `input ${v.key} needs revalidation`, false);
      }
      // A parent container that had already settled is reopened.
      let parent = task.parent_task_id ? this.store.tasks.get(task.parent_task_id) : undefined;
      while (parent) {
        if (parent.status === 'accepted') {
          parent.status = 'active';
          parent.currency = 'needs_revalidation';
          this.touch(parent, null);
          for (const dep of this.dependentsOf(parent.id)) visit(dep, `prerequisite ${parent.key} reopened`, false);
        }
        parent = parent.parent_task_id ? this.store.tasks.get(parent.parent_task_id) : undefined;
      }
    };
    for (const id of consumers) visit(id, reason, true);
    if (impacts.length) this.store.emit({ type: 'impact_recorded', mission_id, actor_id: 'runtime', actor_kind: 'runtime', payload: { cause_artifact: key, cause_version_no: version.version_no, affected: impacts.map((i) => ({ key: i.key, action: i.action })) } });
    return impacts;
  }

  // ───────────────────────────── verification and acceptance ─────────────────────────────

  recordVerification(v: { task_id: string; verifier_task_id?: string | null; criterion_id: string; method: VerificationKind; verdict: Verification['verdict']; verifier_id: string; evidence_ids?: string[]; details?: Record<string, unknown>; target_version_id?: string | null }): Verification {
    return this.store.db.tx(() => {
      const task = this.store.tasks.must(v.task_id);
      const authors = new Set(this.store.attempts.where('"task_id" = ?', task.id).map((a) => a.agent_id));
      const rec: Verification = {
        id: newId('vrf'),
        mission_id: task.mission_id,
        task_id: task.id,
        verifier_task_id: v.verifier_task_id ?? null,
        target_version_id: v.target_version_id ?? null,
        criterion_id: v.criterion_id,
        method: v.method,
        verdict: v.verdict,
        evidence_ids: v.evidence_ids ?? [],
        verifier_id: v.verifier_id,
        independent: !authors.has(v.verifier_id),
        generation: task.generation,
        details: v.details ?? {},
        created_at: this.clock.iso(),
      };
      this.store.verifications.put(rec);
      this.store.emit({ type: 'verification_recorded', mission_id: task.mission_id, task_id: task.id, actor_id: v.verifier_id, actor_kind: 'agent', payload: { key: task.key, criterion_id: v.criterion_id, verdict: v.verdict, method: v.method, independent: rec.independent, generation: task.generation } });
      return rec;
    });
  }

  /** Which mandatory criteria still lack a passing verification for the current generation. */
  acceptanceGaps(task: Task): { criterion_id: string; reason: string }[] {
    const gaps: { criterion_id: string; reason: string }[] = [];
    const vs = this.store.verifications.where('"task_id" = ? AND "generation" = ?', task.id, task.generation);
    for (const c of task.contract.acceptance_criteria) {
      if (!c.mandatory) continue;
      const mine = vs.filter((v) => v.criterion_id === c.criterion_id);
      const latest = mine.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).at(-1);
      if (!latest) gaps.push({ criterion_id: c.criterion_id, reason: 'no verification for the current generation' });
      else if (latest.verdict !== 'pass') gaps.push({ criterion_id: c.criterion_id, reason: `latest verdict is ${latest.verdict}` });
      else if (task.contract.verification.independent && !latest.independent) gaps.push({ criterion_id: c.criterion_id, reason: 'verification was not independent of the author' });
    }
    return gaps;
  }

  /**
   * Accept a task. Activity, agreement between agents, confident prose or valid JSON never
   * satisfies a criterion — only a passing verification for the current generation does.
   */
  acceptTask(task_id: string, actor: string): Task {
    return this.store.db.tx(() => {
      const task = this.store.tasks.must(task_id);
      assert(['submitted', 'verifying'].includes(task.status), 'bad_transition', `Cannot accept a task that is ${task.status}`, { status: task.status });
      const gaps = task.contract.verification.method === 'none' ? [] : this.acceptanceGaps(task);
      assert(gaps.length === 0, 'acceptance_incomplete', `Task ${task.key} has unverified mandatory criteria: ${gaps.map((g) => g.criterion_id).join(', ')}`, { gaps });
      task.status = 'accepted';
      task.currency = 'current';
      this.touch(task, null);
      this.budget.close(task.budget_account_id);
      this.store.setMeta(`task:${task.id}:accepted`, { generation: task.generation, inputs: Object.fromEntries(task.contract.inputs.map((i) => [i.artifact_key, i.content_hash])), upstream: this.upstreamFingerprint(task) });
      this.store.emit({ type: 'task_accepted', mission_id: task.mission_id, task_id, actor_id: actor, actor_kind: 'runtime', payload: { key: task.key, generation: task.generation, attempt: task.attempt }, release_id: task.contract.release_id });
      return task;
    });
  }

  /**
   * Reuse a verified result instead of redoing it. Allowed only when the task was accepted before
   * and every input it would pin now has the same content as when it was accepted.
   */
  revalidateWithoutRerun(task_id: string): boolean {
    return this.store.db.tx(() => {
      const task = this.store.tasks.must(task_id);
      if (task.currency !== 'needs_revalidation' || !['planned', 'ready'].includes(task.status)) return false;
      const prior = this.store.getMeta<{ generation: number; inputs: Record<string, string>; upstream: string }>(`task:${task.id}:accepted`);
      if (!prior) return false;
      // Everything its prerequisites produced must also be byte-identical to what it was built on.
      if (prior.upstream !== this.upstreamFingerprint(task)) return false;
      const keys = this.inputKeys(task.id);
      if (keys.length !== Object.keys(prior.inputs).length) return false;
      const pins: InputRef[] = [];
      for (const key of keys) {
        const v = this.currentVersion(task.mission_id, key);
        if (!v || v.currency !== 'current' || v.content_hash !== prior.inputs[key]) return false;
        pins.push({ artifact_key: key, version_id: v.id, content_hash: v.content_hash, relation: 'uses' });
      }
      const deps = this.dependenciesOf(task.id).map((d) => this.store.tasks.must(d));
      if (!deps.every((d) => d.status === 'accepted' && d.currency === 'current')) return false;
      for (const v of this.store.verifications.where('"task_id" = ? AND "generation" = ?', task.id, prior.generation)) {
        this.store.verifications.put({ ...v, id: newId('vrf'), generation: task.generation, details: { ...v.details, reused_from: v.id }, created_at: this.clock.iso() });
      }
      for (const v of this.store.versions.where('"produced_by_task_id" = ? AND "currency" = ?', task.id, 'needs_revalidation')) {
        v.currency = 'current';
        this.store.versions.put(v);
      }
      this.store.db.run('DELETE FROM task_inputs WHERE task_id = ?', task.id);
      for (const p of pins) this.store.db.run('INSERT INTO task_inputs (task_id, artifact_key, version_id) VALUES (?, ?, ?)', task.id, p.artifact_key, p.version_id);
      task.contract.inputs = pins;
      task.status = 'accepted';
      task.currency = 'current';
      this.touch(task, null);
      this.store.setMeta(`task:${task.id}:accepted`, { generation: task.generation, inputs: prior.inputs, upstream: prior.upstream });
      this.store.emit({ type: 'task_revalidated_without_rerun', mission_id: task.mission_id, task_id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: task.key, generation: task.generation, reason: 'all inputs have unchanged content' } });
      return true;
    });
  }

  /**
   * Fingerprint of everything a task's prerequisites currently provide: the content hashes of the
   * current artifacts produced by each prerequisite, including every task inside a prerequisite team.
   */
  upstreamFingerprint(task: Task): string {
    const producers = new Set<string>();
    const collect = (id: string): void => {
      if (producers.has(id)) return;
      producers.add(id);
      for (const child of this.store.tasks.where('"parent_task_id" = ?', id)) collect(child.id);
    };
    for (const dep of this.dependenciesOf(task.id)) collect(dep);
    const parts: string[] = [];
    for (const id of producers) {
      for (const v of this.store.versions.where('"produced_by_task_id" = ?', id)) {
        if (v.currency === 'current') parts.push(`${v.key}=${v.content_hash}`);
      }
    }
    return sha256(parts.sort().join('\n'));
  }

  /** Verification failed: send the work back, bounded by the repair limit. */
  rejectTask(task_id: string, actor: string, reason: string, failure_class = 'acceptance_failure'): Task {
    return this.store.db.tx(() => {
      const task = this.store.tasks.must(task_id);
      assert(['submitted', 'verifying', 'accepted'].includes(task.status), 'bad_transition', `Cannot reject a task that is ${task.status}`, { status: task.status });
      task.repairs += 1;
      this.store.setMeta(`task:${task.id}:rework`, { reason: truncate(reason, 1200), failure_class, repairs: task.repairs, at: this.clock.iso() });
      this.observe({ mission_id: task.mission_id, task_id, kind: 'rework', failure_class, certainty: 'verified', details: { reason: truncate(reason, 400), repairs: task.repairs }, component: 'execution', release_id: task.contract.release_id, source: this.sourceOf(task.mission_id) });
      if (task.repairs > this.limits.max_repair_attempts) {
        // Work that had been accepted and is now failed takes its team with it: the team is no
        // longer done, so nothing that waits on the team may start.
        if (task.status === 'accepted') {
          task.generation += 1;
          this.reopenAncestors(task);
        }
        task.status = 'failed';
        this.touch(task, this.nextAction(task.contract.escalation.path[0] ?? 'chief_of_staff', 'agent', `Repair limit reached: ${task.title}`));
        this.budget.close(task.budget_account_id);
        this.store.emit({ type: 'task_failed', mission_id: task.mission_id, task_id, actor_id: actor, actor_kind: 'runtime', payload: { key: task.key, code: 'repair_limit', reason } });
      } else {
        // Reopening settled work starts a new generation; its closed account is replaced when it is next leased.
        if (task.status === 'accepted') {
          task.generation += 1;
          this.reopenAncestors(task);
        }
        task.status = 'ready';
        this.touch(task, this.nextAction(task.owner_id, 'agent', `Rework: ${truncate(reason, 100)}`));
        this.store.emit({ type: 'task_rework', mission_id: task.mission_id, task_id, actor_id: actor, actor_kind: 'runtime', payload: { key: task.key, reason: truncate(reason, 400), repairs: task.repairs } });
      }
      return task;
    });
  }

  /** Runtime-executed steps (integration, verification, packets) take a lease like any other owner. */
  setStatus(task_id: string, status: Task['status'], actor: string, next: NextAction | null = null): Task {
    return this.store.db.tx(() => {
      const task = this.store.tasks.must(task_id);
      const from = task.status;
      task.status = status;
      this.touch(task, next);
      this.store.emit({ type: 'task_status_changed', mission_id: task.mission_id, task_id, actor_id: actor, actor_kind: 'runtime', payload: { key: task.key, from, to: status } });
      return task;
    });
  }

  // ───────────────────────────── cancellation ─────────────────────────────

  /**
   * Cancel a task and all of its descendants: stop their workers, release their reservations,
   * keep their artifacts. Returns the worker processes that must be stopped.
   */
  cancelTree(root_task_id: string, actor: string, reason: string): { cancelled: string[]; pids: number[]; released: ResourceAmounts[] } {
    return this.store.db.tx(() => {
      const cancelled: string[] = [];
      const pids: number[] = [];
      const released: ResourceAmounts[] = [];
      const visit = (id: string): void => {
        const task = this.store.tasks.must(id);
        for (const child of this.store.tasks.where('"parent_task_id" = ?', id)) visit(child.id);
        if (TERMINAL.includes(task.status)) return;
        if (task.status === 'leased') {
          const a = this.attemptFor(task.id, task.attempt);
          if (a?.pid) pids.push(a.pid);
          this.endAttempt(task, task.attempt, 'cancelled', null, { error: { code: 'cancelled', message: reason } });
        }
        task.status = 'cancelled';
        task.lease_owner = null;
        task.lease_expires_at = null;
        this.touch(task, null);
        released.push(this.budget.close(task.budget_account_id));
        cancelled.push(task.key);
        this.store.emit({ type: 'task_cancelled', mission_id: task.mission_id, task_id: task.id, actor_id: actor, actor_kind: 'runtime', payload: { key: task.key, reason, artifacts_preserved: true } });
      };
      visit(root_task_id);
      return { cancelled, pids, released };
    });
  }

  cancelMission(cmd: Command<{ mission_id: string; reason: string }>): { mission: Mission; cancelled: string[]; pids: number[] } {
    return this.store.idempotent(cmd.key, 'cancelMission', cmd.data, () => {
      const mission = this.store.missions.must(cmd.data.mission_id);
      const cancelled: string[] = [];
      const pids: number[] = [];
      for (const t of this.store.tasks.where('"mission_id" = ? AND "parent_task_id" IS NULL', mission.id)) {
        const r = this.cancelTree(t.id, cmd.actor, cmd.data.reason);
        cancelled.push(...r.cancelled);
        pids.push(...r.pids);
      }
      mission.cancel_reason = cmd.data.reason;
      this.store.missions.put(mission);
      this.setMissionStatus(mission.id, 'cancelled', cmd.actor, { reason: cmd.data.reason, cancelled_tasks: cancelled.length });
      this.budget.close(mission.budget_account_id);
      return { mission: this.store.missions.must(mission.id), cancelled, pids };
    }).result;
  }

  // ───────────────────────────── recovery ─────────────────────────────

  /**
   * Bring durable state back to a consistent point after a coordinator restart.
   * Nothing is reconstructed from conversation history; everything needed is in the store.
   */
  recover(): { orphaned_attempts: { task_key: string; attempt_no: number; pid: number | null; alive: boolean }[]; freed_slots: number; budgets: { mission_id: string; ok: boolean; discrepancies: string[] }[] } {
    return this.store.db.tx(() => {
      const orphaned: { task_key: string; attempt_no: number; pid: number | null; alive: boolean }[] = [];
      for (const a of this.store.attempts.where(`"status" = 'running'`)) {
        const task = this.store.tasks.must(a.task_id);
        const alive = a.pid ? pidAlive(a.pid) : false;
        orphaned.push({ task_key: task.key, attempt_no: a.attempt_no, pid: a.pid, alive });
        if (task.status === 'leased' && task.attempt === a.attempt_no) {
          // The previous coordinator's handle on this worker is gone. Fence it and requeue.
          this.endAttempt(task, a.attempt_no, 'expired', null, { error: { code: 'coordinator_restart', message: 'Attempt was in flight when the coordinator stopped' } });
          task.status = 'ready';
          task.lease_owner = null;
          task.lease_expires_at = null;
          this.touch(task, this.nextAction(task.owner_id, 'agent', `Resume after restart: ${task.title}`));
          this.store.emit({ type: 'attempt_orphaned', mission_id: task.mission_id, task_id: task.id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: task.key, attempt_no: a.attempt_no, pid: a.pid, worker_alive: alive } });
        } else {
          a.status = 'superseded';
          a.ended_at = this.clock.iso();
          this.store.attempts.put(a);
        }
      }
      const before = this.activeCalls();
      this.store.db.run(`DELETE FROM active_calls WHERE attempt_id NOT IN (SELECT id FROM attempts WHERE status = 'running')`);
      const freed_slots = before - this.activeCalls();
      const budgets = this.store.missions.where('1=1').map((m) => ({ mission_id: m.id, ...this.budget.reconcile(m.budget_account_id) }));
      this.store.emit({ type: 'recovery_completed', actor_id: 'runtime', actor_kind: 'runtime', payload: { orphaned: orphaned.length, freed_slots, budgets_ok: budgets.every((b) => b.ok) } });
      return { orphaned_attempts: orphaned, freed_slots, budgets: budgets.map((b) => ({ mission_id: b.mission_id, ok: b.ok, discrepancies: b.discrepancies })) };
    });
  }

  /** Label for records produced on behalf of a mission: live model execution or a labeled fixture. */
  sourceOf(mission_id: string | null): SourceLabel {
    if (!mission_id) return 'fixture';
    return this.store.missions.get(mission_id)?.provider_mode === 'live' ? 'live' : 'fixture';
  }

  // ───────────────────────────── observations ─────────────────────────────

  observe(o: Omit<Observation, 'id' | 'created_at' | 'signature'> & { signature?: string }): Observation {
    const rec: Observation = { ...o, id: newId('obs'), signature: o.signature ?? `${o.kind}:${o.failure_class}`, created_at: this.clock.iso() };
    this.store.observations.put(rec);
    return rec;
  }
}
