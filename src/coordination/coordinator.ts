import type { Mission, Task, UsageRecord, WorkOutput } from '../contracts/types.ts';
import type { Token } from '../kernel/kernel.ts';
import type { Provider, WorkResult, WorkerHandle } from '../providers/provider.ts';
import { type ReleaseDefs, type Runtime, type Scenario, loadDefs, loadScenario } from '../runtime.ts';
import { SwarmError, globMatch, pidAlive, sleep, truncate } from '../lib/util.ts';
import { scopeSignature } from '../kernel/intake.ts';
import { materializePlan } from './plan.ts';
import { Steps } from './steps.ts';
import { recordOutcome } from './metrics.ts';
import { contextPacket, creditMemories, ingestKnowledge } from '../memory/memory.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface FaultSpec {
  task_key: string;
  /** Attempt number the fault applies to, or `*` for every attempt. */
  attempt: number | '*';
  fault: string;
}

interface Running {
  handle: WorkerHandle;
  task_id: string;
  token: Token;
}

/**
 * Mission coordination loop.
 *
 * The coordinator holds no state of its own that matters: everything it needs is read from the
 * store on each tick, so it can be killed and restarted at any point. It proposes nothing —
 * it dispatches work that the kernel says is ready and applies results through the kernel.
 */
export class Coordinator {
  rt: Runtime;
  steps: Steps;
  private running = new Map<string, Running>();
  private busy = new Set<string>();
  private pending = new Set<Promise<void>>();
  private defsCache = new Map<string, ReleaseDefs>();
  log: (msg: string) => void;
  /** Set by the memory module: turns accepted knowledge notes into scoped memories. */
  onKnowledge: ((task: Task, doc: Record<string, unknown>) => void) | null = null;

  constructor(rt: Runtime, opts: { log?: (msg: string) => void } = {}) {
    this.rt = rt;
    this.log = opts.log ?? (() => undefined);
    this.steps = new Steps(this);
    this.onKnowledge = (task, doc) => void ingestKnowledge(rt, task, doc);
  }

  defs(release_id: string): ReleaseDefs {
    let d = this.defsCache.get(release_id);
    if (!d) {
      d = loadDefs(this.rt, release_id);
      this.defsCache.set(release_id, d);
    }
    return d;
  }

  scenario(m: Mission): Promise<Scenario> {
    return loadScenario(m.scenario ?? 'generic');
  }

  provider(m: Mission): Provider {
    return m.provider_mode === 'live' ? this.rt.providers.live : this.rt.providers.fixture;
  }

  // ───────── recovery ─────────

  /** Run once when a coordinator starts: fence anything the previous coordinator left in flight. */
  recover(): ReturnType<Runtime['kernel']['recover']> {
    const report = this.rt.kernel.recover();
    for (const o of report.orphaned_attempts) {
      if (o.pid && o.alive) {
        try {
          process.kill(o.pid, 'SIGKILL'); // an orphan may not keep working under a lease it no longer holds
        } catch {
          /* already gone */
        }
      }
    }
    for (const m of this.rt.store.missions.where(`"status" IN ('planning', 'active')`)) {
      this.rt.workspaces.recoverIntegration(m.id);
      for (const item of this.rt.store.integration.where(`"mission_id" = ? AND "status" IN ('merging', 'verifying')`, m.id)) {
        item.status = 'superseded';
        item.updated_at = this.rt.store.clock.iso();
        this.rt.store.integration.put(item);
      }
    }
    this.log(`recovery: ${report.orphaned_attempts.length} in-flight attempt(s) fenced, ${report.freed_slots} call slot(s) freed`);
    return report;
  }

  // ───────── main loop ─────────

  /** The operator's kill switch: while this file exists nothing is dispatched and running workers are stopped. */
  stopRequested(): boolean {
    return existsSync(join(this.rt.paths.home, 'STOP'));
  }

  async runUntilIdle(opts: { mission_id?: string; max_ms?: number; poll_ms?: number } = {}): Promise<'idle' | 'timeout' | 'stopped'> {
    const deadline = Date.now() + (opts.max_ms ?? 120_000);
    let quiet = 0;
    while (Date.now() < deadline) {
      if (this.stopRequested()) {
        this.stop();
        this.rt.store.emit({ type: 'coordinator_stopped', actor_id: 'operator', actor_kind: 'operator', payload: { reason: 'STOP file present', workers_stopped: this.running.size } });
        return 'stopped';
      }
      const { active } = await this.tick(opts.mission_id);
      if (active) quiet = 0;
      else if (++quiet >= 2) return 'idle';
      await sleep(opts.poll_ms ?? 40);
    }
    return 'timeout';
  }

  async tick(only?: string): Promise<{ active: boolean }> {
    const { kernel, store } = this.rt;
    let progressed = false;

    for (const { task, attempt } of kernel.expireLeases()) {
      progressed = true;
      this.log(`lease expired on ${task.key} (attempt ${attempt?.attempt_no})`);
      // A worker that stopped heartbeating is stopped when it can be reached. One that cannot be
      // reached (simulated by an injected fault) is left to the fencing token.
      if (attempt && !store.getMeta<boolean>(`attempt:${attempt.id}:unreachable`)) this.killAttempt(attempt.id, attempt.pid);
    }

    const missions = store.missions
      .where(`"status" IN ('planning', 'active')`)
      .filter((m) => !only || m.id === only)
      .sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));

    for (const m of missions) {
      if (store.tasks.count('"mission_id" = ?', m.id) === 0) {
        await this.bootstrap(m);
        progressed = true;
      }
      if (kernel.refreshReadiness(m.id).length) progressed = true;

      // Reuse a verified result before paying to redo it.
      let reused = false;
      for (const t of store.tasks.where(`"mission_id" = ? AND "currency" = 'needs_revalidation' AND "status" IN ('planned', 'ready')`, m.id)) {
        if (kernel.revalidateWithoutRerun(t.id)) {
          reused = true;
          this.log(`reused verified result for ${t.key}`);
        }
      }
      if (reused) {
        kernel.refreshReadiness(m.id);
        progressed = true;
      }

      this.unblockCapacity(m);

      for (const t of store.tasks.where(`"mission_id" = ? AND "status" = 'submitted'`, m.id)) {
        if (this.busy.has(t.id) || kernel.verifiersOf(t.id).length > 0) continue;
        this.spawnStep(t, () => this.steps.verifyInline(t.id));
        progressed = true;
      }

      const ready = store.tasks.where(`"mission_id" = ? AND "status" = 'ready'`, m.id).sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at) || a.key.localeCompare(b.key));
      for (const t of ready) {
        if (this.busy.has(t.id)) continue;
        if (await this.dispatch(m, t)) progressed = true;
      }
      if (this.updateMissionState(m.id)) progressed = true;
    }
    return { active: progressed || this.running.size > 0 || this.busy.size > 0 };
  }

  private async bootstrap(m: Mission): Promise<void> {
    const scenario = await this.scenario(m);
    const plan = scenario.bootstrapPlan({ mission: m, defs: this.defs(m.release_id) });
    materializePlan(this.rt.kernel, m, plan, null);
    this.log(`bootstrapped mission ${m.id} with a ${plan.topology} plan`);
  }

  private unblockCapacity(m: Mission): void {
    const provider = this.provider(m);
    if (!provider.available().ok) return;
    for (const t of this.rt.store.tasks.where(`"mission_id" = ? AND "status" = 'blocked'`, m.id)) {
      if (t.blocked_reason === 'provider_rate_limited' || t.blocked_reason === 'provider_unavailable') this.rt.kernel.unblock(t.id, 'runtime', 'provider reports capacity');
    }
  }

  // ───────── dispatch ─────────

  private async dispatch(m: Mission, t: Task): Promise<boolean> {
    switch (t.executor) {
      case 'worker':
        return this.dispatchWorker(m, t);
      case 'runtime:integrate':
        this.spawnStep(t, () => this.steps.integrate(t.id));
        return true;
      case 'runtime:verify':
        this.spawnStep(t, () => this.steps.verify(t.id));
        return true;
      case 'runtime:review_packet':
        this.spawnStep(t, () => this.steps.reviewPacket(t.id));
        return true;
      case 'runtime:select':
        this.spawnStep(t, () => this.steps.select(t.id));
        return true;
      default:
        return false;
    }
  }

  /**
   * Reuse a verified result from another mission instead of repeating the work. Allowed only when
   * the capability, the objective and the content of every input are identical, the earlier result
   * is accepted and current, it was produced under the same release, and it is still fresh.
   */
  private tryReuse(m: Mission, t: Task): boolean {
    const { kernel, store, intake } = this.rt;
    const defs = this.defs(m.release_id);
    const capability = kernel.params(t.id).reuse_capability;
    if (typeof capability !== 'string' || !defs.coordination.reuse.enabled) return false;
    const hashes = kernel.inputKeys(t.id).map((k) => kernel.currentVersion(m.id, k)?.content_hash);
    if (hashes.some((x) => !x)) return false;
    const signature = scopeSignature({ capability, objective: t.contract.objective, input_hashes: hashes as string[] });
    if (t.scope_signature !== signature) store.tasks.put({ ...store.tasks.must(t.id), scope_signature: signature });
    const source = intake.reusable(signature, m.id, defs.coordination.reuse.max_age_ms);
    if (!source || source.contract.release_id !== m.release_id) return false;
    const lease = kernel.claim(t.id, t.owner_id, { provider: 'reuse', provider_mode: m.provider_mode, model_requested: null, uses_call_slot: false });
    if (!lease) return false;
    store.db.tx(() => {
      const artifacts = store.versions.where('"produced_by_task_id" = ? AND "currency" = ?', source.id, 'current').flatMap((v) => {
        const content = kernel.readArtifact(v);
        return content === null ? [] : [{ key: v.key, kind: store.artifacts.must(v.artifact_id).kind, media_type: v.media_type, content }];
      });
      const prior = store.getMeta<{ remaining_uncertainty: string[] }>(`task:${source.id}:output:g${source.generation}`);
      kernel.submitResult(t.id, lease.token, { status: 'completed', summary: `Reused the verified result of ${source.key} from mission ${source.mission_id}`, artifacts, evidence: [{ kind: 'reuse', statement: `Result reused from ${source.key} in mission ${source.mission_id}: same capability, objective and input content, accepted and current, same release.`, epistemic: 'observed_fact', origin: 'runtime', refs: [source.id] }], criteria_claims: [], remaining_uncertainty: prior?.remaining_uncertainty ?? [], questions: [], proposals: [] }, null, { source: kernel.sourceOf(m.id) });
      // The earlier verdicts carry over as recorded verdicts, each pointing at its original.
      for (const v of store.verifications.where('"task_id" = ? AND "generation" = ?', source.id, source.generation)) {
        kernel.recordVerification({ task_id: t.id, criterion_id: v.criterion_id, method: v.method, verdict: v.verdict, verifier_id: 'runtime:reuse', evidence_ids: v.evidence_ids, details: { reused_from: v.id, source_task: source.id, source_mission: source.mission_id } });
      }
      store.emit({ type: 'result_reused_across_missions', mission_id: m.id, task_id: t.id, actor_id: 'runtime', actor_kind: 'runtime', payload: { key: t.key, source_mission: source.mission_id, source_task: source.key, signature, artifacts: artifacts.map((a) => a.key) } });
    });
    this.spawnStep(t, () => this.steps.verifyInline(t.id));
    this.log(`reused ${t.key} from mission ${source.mission_id}`);
    return true;
  }

  private async dispatchWorker(m: Mission, t: Task): Promise<boolean> {
    const { kernel, store, workspaces } = this.rt;
    if (this.tryReuse(m, t)) return true;
    const provider = this.provider(m);
    const gate = provider.available();
    if (!gate.ok) {
      // Fail closed: no fallback to another provider, and no pretending a fixture is live.
      kernel.block(store.tasks.must(t.id), 'provider_unavailable', { owner_id: 'operator', owner_kind: 'operator', action: truncate(gate.reason ?? 'provider unavailable', 140), since: store.clock.iso() });
      return true;
    }
    const defs = this.defs(m.release_id);
    const arch = t.contract.assignee.archetype;
    const route = defs.execution.routing.by_role[t.contract.assignee.role] ?? defs.execution.routing.by_archetype[arch] ?? defs.execution.routing.default;
    const lease = kernel.claim(t.id, t.owner_id, { provider: provider.name, provider_mode: provider.mode, model_requested: provider.mode === 'live' ? route.model : null, uses_call_slot: true });
    if (!lease) return false;
    const { task, attempt, token } = lease;

    const scenario = await this.scenario(m);
    const inputs: Record<string, string> = {};
    for (const i of task.contract.inputs) {
      const v = store.versions.get(i.version_id);
      const content = v ? kernel.readArtifact(v) : null;
      if (content !== null) inputs[i.artifact_key] = content;
    }
    let workspace: { dir: string; branch: string | null; base_commit: string | null } | null = null;
    if (task.contract.required_outputs.some((o) => o.kind === 'code')) {
      if (!scenario.config.app_seed) throw new SwarmError('no_app_seed', `Scenario ${scenario.name} has no application to work on`);
      workspaces.initMissionRepo(m.id, join(scenario.dir, scenario.config.app_seed));
      const wt = workspaces.createWorktree(m.id, task.key, token.attempt, token.generation);
      workspaces.materializeInputs(
        wt.dir,
        Object.entries(inputs).flatMap(([key, content]) => {
          const files = [{ path: `.inputs/${key.replace(/[^a-zA-Z0-9_.-]+/g, '_')}`, content }];
          const dest = scenario.config.materialize[key];
          if (dest) files.push({ path: dest, content });
          return files;
        }),
      );
      // Pinned inputs are committed by the runtime, so the worker's own changes are exactly what follows.
      workspaces.commitAll(wt.dir, `Pin inputs for ${task.key}`);
      workspace = wt;
      kernel.heartbeat(task.id, token, { workspace: { ...wt, head_commit: null } });
    }
    this.acceptHandoffs(task);
    const rework = store.getMeta<{ reason: string; repairs: number }>(`task:${task.id}:rework`);
    // Context selection is part of the execution definitions, so it is versioned and improvable.
    const context = contextPacket(this.rt, m, task, { max: defs.execution.context.max_memories, include_failed_approaches: defs.execution.context.include_failed_approaches });
    const faults = (store.getMeta<FaultSpec[]>(`faults:${m.id}`) ?? []).filter((f) => f.task_key === task.key && (f.attempt === '*' || f.attempt === token.attempt)).map((f) => f.fault);
    const handle = provider.start(
      {
        attempt_id: attempt.id,
        task,
        mission: m,
        token,
        workspace,
        inputs,
        params: { ...kernel.params(task.id), ...(rework ? { previous_attempt_rejected_because: rework.reason } : {}) },
        instructions: [defs.execution.agents[arch]?.instructions ?? '', context.text].filter(Boolean).join('\n\n'),
        model: route.model,
        effort: route.effort,
        timeout_ms: Math.max(5_000, task.contract.resources.reservation.wall_ms),
        max_budget_usd: provider.mode === 'live' ? task.contract.resources.reservation.cost_usd_est : null,
        faults,
        db_path: this.rt.paths.db,
        artifact_dir: this.rt.paths.artifacts,
        lease_ms: this.rt.limits.lease_ms,
      },
      { onHeartbeat: (info) => void kernel.heartbeat(task.id, token, info) },
    );
    if (faults.some((f) => f.startsWith('stall_then_submit'))) store.setMeta(`attempt:${attempt.id}:unreachable`, true);
    this.running.set(attempt.id, { handle, task_id: task.id, token });
    this.log(`dispatched ${task.key} (${provider.name}, token g${token.generation}a${token.attempt}${faults.length ? `, INJECTED FAULT ${faults.join('+')}` : ''})`);
    const p = handle.done.then((res) => this.onWorkerDone(attempt.id, task.id, token, res, workspace)).catch((err) => this.log(`worker completion error on ${task.key}: ${String(err)}`));
    this.track(p);
    return true;
  }

  private onWorkerDone(attempt_id: string, task_id: string, token: Token, res: WorkResult, workspace: { dir: string; branch: string | null; base_commit: string | null } | null): void {
    const { kernel, store, workspaces } = this.rt;
    this.running.delete(attempt_id);
    const task = store.tasks.must(task_id);
    const source = kernel.sourceOf(task.mission_id);
    if (res.status === 'ok' && res.self_submitted) return;
    if (res.status === 'ok' && res.output) {
      let git: { commit: string; tree: string; key: string } | null = null;
      let head_commit: string | null = null;
      if (workspace) {
        // The runtime, not the worker, decides whether the write scope was respected.
        workspaces.git(workspace.dir, ['add', '-A']);
        const changed = workspaces.git(workspace.dir, ['diff', '--cached', '--name-only']).split('\n').filter((f) => f && !f.startsWith('.inputs/'));
        const outside = changed.filter((f) => !task.contract.authority.write_scope.some((g) => globMatch(g, f)));
        if (outside.length) {
          kernel.failAttempt(task_id, token, 'failed', { code: 'write_scope_violation', message: `wrote outside its scope: ${outside.slice(0, 5).join(', ')}` }, res.usage, { countsAsRetry: true });
          return;
        }
        const c = workspaces.commitAll(workspace.dir, `${task.key}: ${truncate(res.output.summary, 60)}`);
        const head = c ?? workspaces.head(workspace.dir);
        head_commit = head.commit;
        const codeOut = task.contract.required_outputs.find((o) => o.kind === 'code');
        if (codeOut) git = { commit: head.commit, tree: head.tree, key: codeOut.key };
      }
      kernel.submitResult(task_id, token, res.output, res.usage, { model_actual: res.model_actual, session_id: res.session_id, git, source, ...(workspace ? { workspace: { ...workspace, head_commit } } : {}) });
      return;
    }
    const status = res.status === 'ok' ? 'invalid_output' : res.status === 'timeout' ? 'failed' : res.status;
    kernel.failAttempt(task_id, token, status, res.error ?? { code: res.status, message: res.status }, res.usage, { countsAsRetry: res.status !== 'rate_limited' });
  }

  /** The next owner accepts the handoffs addressed to them when they pick the work up. */
  acceptHandoffs(task: Task): void {
    for (const h of this.rt.store.handoffs.where(`"task_id" = ? AND "status" = 'offered'`, task.id)) {
      if (h.to_owner === task.owner_id) this.rt.comms.resolveHandoff(h.id, task.owner_id, true, 'accepted on pickup');
    }
  }

  // ───────── helpers used by steps ─────────

  spawnStep(t: Task, fn: () => Promise<void>): void {
    this.busy.add(t.id);
    const p = fn()
      .catch((err) => {
        this.log(`step failed on ${t.key}: ${err instanceof Error ? err.message : String(err)}`);
        const cur = this.rt.store.tasks.get(t.id);
        if (cur && cur.status === 'leased') {
          this.rt.kernel.failAttempt(t.id, { attempt: cur.attempt, generation: cur.generation }, 'failed', { code: err instanceof SwarmError ? err.code : 'step_error', message: err instanceof Error ? err.message : String(err) }, null, { countsAsRetry: true });
        }
      })
      .finally(() => {
        this.busy.delete(t.id);
      });
    this.track(p);
  }

  private track(p: Promise<void>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  killAttempt(attempt_id: string, pid: number | null): void {
    const r = this.running.get(attempt_id);
    if (r) r.handle.kill('SIGKILL');
    else if (pid && pidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }

  killPids(pids: number[]): void {
    for (const pid of pids) {
      for (const [id, r] of this.running) if (r.handle.pid === pid) this.killAttempt(id, pid);
      if (pidAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  }

  /** Lease a task for a runtime-executed step and keep the lease alive while `fn` runs. */
  async withLease(task_id: string, fn: (task: Task, token: Token, started: number) => Promise<{ output: WorkOutput; git?: { commit: string; tree: string; key: string } | null } | null>): Promise<void> {
    const { kernel, store } = this.rt;
    const t0 = store.tasks.must(task_id);
    const m = store.missions.must(t0.mission_id);
    const lease = kernel.claim(task_id, t0.owner_id, { provider: 'runtime', provider_mode: m.provider_mode, model_requested: null, uses_call_slot: false });
    if (!lease) return;
    this.acceptHandoffs(lease.task);
    const started = Date.now();
    const timer = setInterval(() => void kernel.heartbeat(task_id, lease.token), Math.max(200, Math.floor(this.rt.limits.lease_ms / 4)));
    try {
      const res = await fn(lease.task, lease.token, started);
      if (!res) return; // the step deferred or re-routed the task itself
      const usage: UsageRecord = { source: 'runtime-step', meter_kind: 'runtime_measured', call_count: 0, input_units: null, output_units: null, cache_read_units: null, cache_write_units: null, wall_ms: Date.now() - started, reported_cost: null, currency: null, cost_basis: 'none', completeness: 'complete', observed_at: store.clock.iso() };
      kernel.submitResult(task_id, lease.token, res.output, usage, { source: kernel.sourceOf(m.id), git: res.git ?? null });
    } finally {
      clearInterval(timer);
    }
  }

  // ───────── mission state ─────────

  private updateMissionState(mission_id: string): boolean {
    const { kernel, store, comms } = this.rt;
    const m = store.missions.must(mission_id);
    if (!['planning', 'active'].includes(m.status)) return false;
    const tasks = store.tasks.where('"mission_id" = ?', mission_id);
    if (tasks.length === 0) return false;
    const failed = tasks.filter((t) => t.status === 'failed');
    if (failed.length) {
      const f = failed[0]!;
      if (!store.decisions.first(`"mission_id" = ? AND "kind" = 'failure_escalation' AND "task_id" = ?`, mission_id, f.id)) {
        comms.openDecision({
          mission_id,
          task_id: f.id,
          kind: 'failure_escalation',
          question: `"${f.title}" could not be completed within its retry and repair limits. What should happen?`,
          owner_id: 'chief_of_staff',
          owner_kind: 'chief_of_staff',
          options: [
            { id: 'cancel', label: 'Cancel the mission and keep its artifacts', evidence_ids: [], consequences: ['Remaining reservations are released', 'Completed artifacts stay available'], proposed_by: 'runtime' },
            { id: 'hold', label: 'Hold for a human to investigate', evidence_ids: [], consequences: ['Nothing further runs on this mission'], proposed_by: 'runtime' },
          ],
          requires_human: true,
        });
      }
      kernel.setMissionStatus(mission_id, 'blocked', 'runtime', { reason: `task ${f.key} failed` });
      return true;
    }
    const top = tasks.filter((t) => t.parent_task_id === null);
    if (top.length && top.every((t) => t.status === 'accepted') && tasks.every((t) => ['accepted', 'not_selected', 'cancelled'].includes(t.status))) {
      recordOutcome(this.rt, mission_id);
      creditMemories(this.rt, mission_id);
      kernel.setMissionStatus(mission_id, 'review_ready', 'runtime', { reason: 'all work accepted; awaiting the decision in the review packet' });
      return true;
    }
    return false;
  }

  /** Stop every worker this coordinator started. */
  stop(): void {
    for (const [id, r] of this.running) this.killAttempt(id, r.handle.pid);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}
