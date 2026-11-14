import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IntegrationItem } from '../contracts/runtime.ts';
import type { AcceptanceCriterion, Mission, PlanProposal, ReviewPacket, Task, Verification, WorkOutput } from '../contracts/types.ts';
import type { Token } from '../kernel/kernel.ts';
import { SwarmError, hashOf, newId, truncate } from '../lib/util.ts';
import { type RunResult, parseTap, tapFailures } from '../workspace/workspaces.ts';
import type { Coordinator } from './coordinator.ts';
import { materializePlan, validatePlan } from './plan.ts';

export const VERIFIER_ID = 'runtime:verifier';
const NODE_TEST = ['node', '--disable-warning=ExperimentalWarning', '--test'];

function out(summary: string, extra: Partial<WorkOutput> = {}): WorkOutput {
  return { status: 'completed', summary, artifacts: [], evidence: [], criteria_claims: [], remaining_uncertainty: [], questions: [], proposals: [], ...extra };
}

interface StoredOutput {
  questions?: WorkOutput['questions'];
  summary: string;
  criteria_claims: WorkOutput['criteria_claims'];
  remaining_uncertainty: string[];
  proposals: WorkOutput['proposals'];
  plan: PlanProposal | null;
  version_ids: string[];
  attempt_no: number;
}

/** Work the runtime performs itself. Each step holds a lease like any other owner. */
export class Steps {
  private co: Coordinator;
  constructor(co: Coordinator) {
    this.co = co;
  }

  private get rt() {
    return this.co.rt;
  }

  storedOutput(task: Task): StoredOutput | undefined {
    return this.rt.store.getMeta<StoredOutput>(`task:${task.id}:output:g${task.generation}`);
  }

  /** Current artifacts produced by a task, by key. */
  outputsOf(task: Task): Record<string, string> {
    const res: Record<string, string> = {};
    for (const v of this.rt.store.versions.where('"produced_by_task_id" = ? AND "currency" = ?', task.id, 'current')) {
      const content = this.rt.kernel.readArtifact(v);
      if (content !== null) res[v.key] = content;
    }
    return res;
  }

  /** Keep the raw output of an executed check as an artifact and point an evidence record at it. */
  recordRunEvidence(m: Mission, task: Task, label: string, run: RunResult): string {
    const { kernel, store } = this.rt;
    const results = parseTap(run.stdout);
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    const pub = kernel.publishVersion({
      mission_id: m.id,
      key: `evidence/${task.key}/${label.replace(/[^a-z0-9]+/gi, '-')}`,
      kind: 'test_result',
      media_type: 'text/plain',
      content: `$ ${label}\nexit ${run.code}${run.timed_out ? ' (timed out)' : ''} in ${run.ms} ms\n\n${run.stdout}\n${run.stderr}`.slice(0, 200_000),
      produced_by_task_id: null,
      produced_by_attempt: null,
      inputs: [],
      release_id: m.release_id,
      source: kernel.sourceOf(m.id),
    });
    const id = newId('evd');
    store.evidence.put({
      id,
      mission_id: m.id,
      task_id: task.id,
      kind: 'test_result',
      epistemic: 'observed_fact',
      origin: 'runtime',
      // The check really ran; what it ran against is synthetic fixture data unless the mission is live.
      evidence_class: m.data_class === 'synthetic' ? 'synthetic' : 'empirical',
      statement: `${label}: ${passed} passed, ${failed} failed, exit ${run.code}`,
      canonical_ref: pub.version.key,
      artifact_version_id: pub.version.id,
      content_hash: pub.version.content_hash,
      producer_id: VERIFIER_ID,
      freshness_status: 'fresh',
      verification_status: 'verified',
      observed_at: store.clock.iso(),
    });
    return id;
  }

  private noteEvidence(m: Mission, task: Task, statement: string): string {
    const id = newId('evd');
    this.rt.store.evidence.put({ id, mission_id: m.id, task_id: task.id, kind: 'inspection', epistemic: 'observed_fact', origin: 'runtime', evidence_class: m.data_class === 'synthetic' ? 'synthetic' : 'empirical', statement: truncate(statement, 1000), canonical_ref: null, artifact_version_id: null, content_hash: null, producer_id: VERIFIER_ID, freshness_status: 'fresh', verification_status: 'verified', observed_at: this.rt.store.clock.iso() });
    return id;
  }

  /** Evaluate every criterion of a task that the runtime can check on its own. */
  async evaluateCriteria(task: Task, verifier_task_id: string | null = null): Promise<Verification[]> {
    const { kernel, store, workspaces } = this.rt;
    const m = store.missions.must(task.mission_id);
    const scenario = await this.co.scenario(m);
    const attempt = kernel.attemptFor(task.id, task.attempt);
    const artifacts = this.outputsOf(task);
    const records: Verification[] = [];
    for (const c of task.contract.acceptance_criteria) {
      if (!c.check) {
        if (c.verification_kind !== 'human_review') {
          records.push(kernel.recordVerification({ task_id: task.id, verifier_task_id, criterion_id: c.criterion_id, method: c.verification_kind, verdict: 'inconclusive', verifier_id: VERIFIER_ID, details: { reason: 'no executable check is defined for this criterion' } }));
        }
        continue;
      }
      if (c.check.runner === 'node-test') {
        const dir = attempt?.workspace?.dir;
        if (!dir || !existsSync(dir)) {
          records.push(kernel.recordVerification({ task_id: task.id, verifier_task_id, criterion_id: c.criterion_id, method: 'executable', verdict: 'inconclusive', verifier_id: VERIFIER_ID, details: { reason: 'no workspace to run the check in' } }));
          continue;
        }
        const run = await workspaces.run(dir, [...NODE_TEST, c.check.target], 60_000);
        const evidence = this.recordRunEvidence(m, task, `node --test ${c.check.target}`, run);
        const results = parseTap(run.stdout);
        // An empty run proves nothing: no tests means the criterion is not shown to hold.
        const verdict = run.code === 0 && results.length > 0 ? 'pass' : results.length === 0 && run.code === 0 ? 'inconclusive' : 'fail';
        records.push(kernel.recordVerification({ task_id: task.id, verifier_task_id, criterion_id: c.criterion_id, method: 'executable', verdict, verifier_id: VERIFIER_ID, evidence_ids: [evidence], details: { exit: run.code, tests: results.length, failing: results.filter((r) => !r.ok).map((r) => r.name) } }));
      } else if (c.check.runner.startsWith('inspect:')) {
        const fn = scenario.inspectors[c.check.runner.slice(8)];
        const r = fn ? fn({ task, mission: m, criterion: c, artifacts, rt: this.rt }) : { ok: false, details: `unknown inspector ${c.check.runner}` };
        const evidence = this.noteEvidence(m, task, `${c.check.runner} on ${c.check.target}: ${r.details}`);
        records.push(kernel.recordVerification({ task_id: task.id, verifier_task_id, criterion_id: c.criterion_id, method: 'inspection', verdict: r.ok ? 'pass' : 'fail', verifier_id: VERIFIER_ID, evidence_ids: [evidence], details: { inspector: c.check.runner, details: r.details } }));
      } else {
        records.push(kernel.recordVerification({ task_id: task.id, verifier_task_id, criterion_id: c.criterion_id, method: c.verification_kind, verdict: 'inconclusive', verifier_id: VERIFIER_ID, details: { reason: `unsupported check runner ${c.check.runner}` } }));
      }
    }
    return records;
  }

  // ───────── inline verification ─────────

  async verifyInline(task_id: string): Promise<void> {
    const { kernel, store } = this.rt;
    let task = store.tasks.must(task_id);
    if (task.status !== 'submitted') return;
    const m = store.missions.must(task.mission_id);
    const stored = this.storedOutput(task);

    // A proposed plan is checked before the proposing task can be accepted. Proposing the same plan
    // again after a rerun changes nothing; proposing a different one is a re-plan, which needs a decision.
    const priorPlan = store.getMeta<string>(`task:${task.id}:plan_hash`);
    if (stored?.plan && priorPlan && priorPlan !== hashOf(stored.plan)) {
      kernel.rejectTask(task_id, VERIFIER_ID, 'the task proposes a different plan from the one already in effect; changing a plan in flight needs a decision from its owner', 'replan_requires_decision');
      return;
    }
    if (stored?.plan && !priorPlan) {
      const errors = validatePlan(kernel, m, stored.plan, task);
      if (errors.length) {
        kernel.rejectTask(task_id, VERIFIER_ID, `proposed plan is not valid: ${errors.join('; ')}`, 'invalid_plan');
        return;
      }
    }
    if (task.contract.verification.method !== 'none') {
      const generation = task.generation;
      kernel.setStatus(task_id, 'verifying', VERIFIER_ID, { owner_id: VERIFIER_ID, owner_kind: 'runtime', action: `Verifying: ${task.title}`, since: store.clock.iso() });
      // Verdicts carried over from a reused result are already recorded for this generation.
      const reused = kernel.attemptFor(task.id, task.attempt)?.provider === 'reuse';
      if (!reused) await this.evaluateCriteria(task);
      task = store.tasks.must(task_id);
      if (task.status !== 'verifying' || task.generation !== generation) return; // invalidated or cancelled while checks ran
      const gaps = kernel.acceptanceGaps(task);
      if (gaps.length) {
        const human = task.contract.acceptance_criteria.filter((c) => c.verification_kind === 'human_review' && gaps.some((g) => g.criterion_id === c.criterion_id));
        if (human.length === gaps.length) {
          kernel.block(task, 'awaiting_human_review', { owner_id: m.accountable_human, owner_kind: 'human', action: `Review: ${task.title}`, since: store.clock.iso() });
          return;
        }
        kernel.rejectTask(task_id, VERIFIER_ID, gaps.map((g) => `${g.criterion_id}: ${g.reason}`).join('; '));
        return;
      }
    }
    // Acceptance and its follow-ups commit together, so a crash cannot leave an accepted plan unmaterialized.
    store.db.tx(() => {
      kernel.acceptTask(task_id, VERIFIER_ID);
      this.afterAccept(store.tasks.must(task_id));
    });
  }

  /** Follow-ups once a task is accepted: materialize its plan, offer handoffs, keep stakeholder needs and knowledge. */
  afterAccept(task: Task): void {
    const { kernel, store, comms, intake } = this.rt;
    const m = store.missions.must(task.mission_id);
    const stored = this.storedOutput(task);
    const produced = this.outputsOf(task);
    for (const content of Object.values(produced)) {
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(content) as Record<string, unknown>;
      } catch {
        continue;
      }
      // Distinct stakeholder needs survive consolidation as their own records …
      if (Array.isArray(doc.distinct_needs) && typeof doc.shared_capability === 'string') {
        store.setMeta(`mission:${m.id}:shared_capability`, doc.shared_capability);
        const have = new Set(store.needs.where('"mission_id" = ?', m.id).map((n) => n.request_id));
        for (const n of doc.distinct_needs as { request_id: string; stakeholder: string; need: string }[]) {
          if (!have.has(n.request_id)) intake.recordNeed({ request_id: n.request_id, mission_id: m.id, stakeholder: n.stakeholder, need: n.need });
        }
      }
      // A request the mission was authorized with, left out by discovery, is a change of scope.
      // The work continues on the rest; the change itself is for the chief of staff to accept or refuse.
      if (Array.isArray(doc.consolidated_request_ids) && typeof doc.shared_capability === 'string') {
        const kept = new Set((doc.consolidated_request_ids as unknown[]).filter((x): x is string => typeof x === 'string'));
        for (const id of (m.request_ids ?? []).filter((r) => !kept.has(r))) {
          const req = store.requests.get(id);
          if (!req || store.getMeta<boolean>(`mission:${m.id}:scope_asked:${id}`)) continue;
          store.setMeta(`mission:${m.id}:scope_asked:${id}`, true);
          // The stakeholder's need is kept as a record, marked as not covered by this mission.
          const existing = store.needs.first('"mission_id" = ? AND "request_id" = ?', m.id, id);
          const need = existing ?? intake.recordNeed({ request_id: id, mission_id: m.id, stakeholder: req.stakeholder, need: truncate(req.text, 300) });
          store.needs.put({ ...need, status: 'deferred' });
          const why = ((Array.isArray(doc.interpretations) ? doc.interpretations : []) as unknown[]).filter((x): x is string => typeof x === 'string').find((x) => x.includes(id));
          const asked = this.rt.comms.openDecision({
            mission_id: m.id,
            task_id: task.id,
            kind: 'scope_change',
            question: `Discovery left ${id} (${req.stakeholder}, ${req.team}) out of "${m.title}"${why ? `: ${truncate(why, 360)}` : '.'} The mission is continuing without it. What should happen?`,
            owner_id: 'chief_of_staff',
            owner_kind: 'chief_of_staff',
            requires_human: true,
            options: [
              { id: 'separate', label: 'Handle that request separately', evidence_ids: [], consequences: ['The request returns to intake for a mission of its own', 'This mission continues as it is', 'Its review packet lists the need as not covered'], proposed_by: task.owner_id },
              { id: 'stop', label: 'Stop this mission: that is not the scope I authorized', evidence_ids: [], consequences: ['The mission is cancelled and its artifacts are kept', 'You can submit it again with the scope stated'], proposed_by: 'runtime' },
            ],
          });
          store.setMeta(`decision:${asked.id}:request_id`, id);
          store.emit({ type: 'scope_narrowed', mission_id: m.id, task_id: task.id, actor_id: task.owner_id, actor_kind: 'agent', payload: { request_id: id, stakeholder: req.stakeholder, why: why ? truncate(why, 300) : null } });
        }
      }
      // … and each is tied to the acceptance criterion that decides it.
      if (Array.isArray(doc.needs_map)) {
        for (const map of doc.needs_map as { request_id: string; criterion_id: string }[]) {
          const need = store.needs.first('"mission_id" = ? AND "request_id" = ?', m.id, map.request_id);
          if (need) store.needs.put({ ...need, criterion_id: map.criterion_id, status: 'mapped' });
        }
        for (const d of (doc.deferred_needs ?? []) as { stakeholder: string }[]) {
          const need = store.needs.where('"mission_id" = ?', m.id).find((x) => x.stakeholder === d.stakeholder && x.status === 'open');
          if (need) store.needs.put({ ...need, status: 'deferred' });
        }
      }
      if (Array.isArray(doc.notes)) this.co.onKnowledge?.(task, doc);
    }
    if (stored?.plan && !store.getMeta<string>(`task:${task.id}:plan_hash`)) {
      materializePlan(kernel, m, stored.plan, task);
      store.setMeta(`task:${task.id}:plan_hash`, hashOf(stored.plan));
    }
    // Questions a worker raised are routed to their addressee and stay open until someone answers.
    if (!store.getMeta<boolean>(`task:${task.id}:questions_routed:g${task.generation}`)) {
      for (const q of stored?.questions ?? []) comms.post({ mission_id: m.id, task_id: task.id, from_id: task.owner_id, to: q.to, kind: 'question', body: q.question.slice(0, 1500) });
      store.setMeta(`task:${task.id}:questions_routed:g${task.generation}`, true);
    }
    // Structured handoff to each downstream owner: artifact version, acceptance evidence, what is still uncertain.
    const evidence_ids = store.verifications.where('"task_id" = ? AND "generation" = ?', task.id, task.generation).flatMap((v) => v.evidence_ids);
    const version = stored?.version_ids.at(-1) ?? null;
    for (const depId of kernel.dependentsOf(task.id)) {
      const dep = store.tasks.must(depId);
      if (dep.owner_id === task.owner_id) continue;
      comms.offerHandoff({ mission_id: m.id, task_id: dep.id, from_owner: task.owner_id, to_owner: dep.owner_id, artifact_version_id: version, acceptance_evidence_ids: [...new Set(evidence_ids)], remaining_uncertainty: stored?.remaining_uncertainty ?? [], note: `Result of ${task.key}` });
    }
  }

  // ───────── integration queue ─────────

  /**
   * Merge accepted workstreams one at a time into the integration branch and verify the combined
   * result. The run always rebuilds from the seed commit, so it is safe to repeat after a crash.
   */
  async integrate(task_id: string): Promise<void> {
    const { kernel, store, workspaces } = this.rt;
    await this.co.withLease(task_id, async (task) => {
      const m = store.missions.must(task.mission_id);
      const scenario = await this.co.scenario(m);
      const params = kernel.params(task.id) as { merge_order: string[]; component_tests: Record<string, string>; final_checks: string[]; attribution: Record<string, string>; output_key: string };
      const defs = this.co.defs(m.release_id);
      if (!scenario.config.app_seed) throw new SwarmError('no_app_seed', 'nothing to integrate');
      const { base_commit } = workspaces.initMissionRepo(m.id, join(scenario.dir, scenario.config.app_seed));
      workspaces.resetIntegration(m.id, base_commit);
      const dir = workspaces.integrationDir(m.id);
      const merged: Task[] = [];
      let position = 0;
      for (const key of params.merge_order) {
        const src = store.tasks.first('"mission_id" = ? AND "key" = ?', m.id, key);
        if (!src || src.status !== 'accepted') {
          // Not an error and not a retry: integration simply waits until every workstream is accepted.
          workspaces.resetIntegration(m.id, base_commit);
          kernel.defer(task.id, task.owner_id, `workstream ${key} is not accepted yet`);
          return null;
        }
        const branch = kernel.attemptFor(src.id, src.attempt)?.workspace?.branch;
        if (!branch) throw new SwarmError('integration_input_missing', `workstream ${key} has no branch`);
        const now = store.clock.iso();
        const item: IntegrationItem = { id: newId('int'), mission_id: m.id, task_id: src.id, integrator_task_id: task.id, attempt_no: src.attempt, generation: src.generation, branch, position: position++, status: 'merging', pre_merge_commit: null, merge_commit: null, result: null, created_at: now, updated_at: now };
        store.integration.put(item);
        store.emit({ type: 'integration_merge_started', mission_id: m.id, task_id: task.id, actor_id: task.owner_id, actor_kind: 'agent', payload: { workstream: key, branch, position: item.position } });
        const r = workspaces.merge(m.id, branch, `Integrate ${key}`);
        item.pre_merge_commit = r.pre;
        if (!r.ok) {
          item.status = 'conflict';
          item.result = { ok: false, summary: r.detail, evidence_id: null };
          store.integration.put({ ...item, updated_at: store.clock.iso() });
          this.integrationFailure(task, [src], `merge conflict integrating ${key}: ${truncate(r.detail, 300)}`, 'merge_conflict');
          return null;
        }
        item.merge_commit = r.post;
        const componentTest = params.component_tests?.[key];
        if (defs.coordination.integration.verify_each_merge && componentTest) {
          item.status = 'verifying';
          store.integration.put({ ...item, updated_at: store.clock.iso() });
          const run = await workspaces.run(dir, [...NODE_TEST, componentTest], 60_000);
          const evidence = this.recordRunEvidence(m, task, `after merging ${key}: node --test ${componentTest}`, run);
          if (run.code !== 0) {
            workspaces.resetIntegration(m.id, base_commit);
            item.status = 'rejected';
            item.result = { ok: false, summary: 'component tests failed after merge', evidence_id: evidence };
            store.integration.put({ ...item, updated_at: store.clock.iso() });
            this.integrationFailure(task, [src], `${key} fails its own tests once merged`, 'component_tests_failed');
            return null;
          }
          item.result = { ok: true, summary: 'component tests pass after merge', evidence_id: evidence };
        }
        item.status = 'merged';
        store.integration.put({ ...item, updated_at: store.clock.iso() });
        store.emit({ type: 'integration_merged', mission_id: m.id, task_id: task.id, actor_id: task.owner_id, actor_kind: 'agent', payload: { workstream: key, merge_commit: r.post } });
        merged.push(src);
      }
      const run = await workspaces.run(dir, [...NODE_TEST, ...params.final_checks], 90_000);
      const evidence = this.recordRunEvidence(m, task, `combined result: node --test ${params.final_checks.join(' ')}`, run);
      const results = parseTap(run.stdout);
      if (run.code !== 0 || results.length === 0) {
        const failing = results.filter((r) => !r.ok).map((r) => r.name);
        const responsibleKeys = [...new Set(failing.flatMap((name) => Object.entries(params.attribution ?? {}).filter(([prefix]) => name.startsWith(prefix)).map(([, key]) => key)))];
        const responsible = responsibleKeys.length ? merged.filter((t) => responsibleKeys.includes(t.key)) : merged;
        workspaces.resetIntegration(m.id, base_commit);
        const why = tapFailures(run.stdout).map((f) => `${f.name}${f.message ? ` — ${f.message}` : ''}`);
        this.integrationFailure(task, responsible, truncate(`combined tests fail at the integration boundary: ${why.join('; ') || failing.join('; ') || 'no tests ran'}`, 1600), 'combined_tests_failed');
        return null;
      }
      const head = workspaces.head(dir);
      return {
        output: out(`Merged ${merged.length} workstream(s); ${results.length} combined test(s) pass at ${head.commit.slice(0, 10)}`, {
          evidence: [{ kind: 'test_result', statement: `Combined result passes ${results.length} tests`, epistemic: 'observed_fact', origin: 'runtime', refs: [evidence] }],
        }),
        git: { commit: head.commit, tree: head.tree, key: params.output_key },
      };
    });
  }

  private integrationFailure(integrator: Task, responsible: Task[], reason: string, signature: string): void {
    const { kernel, store } = this.rt;
    kernel.observe({ mission_id: integrator.mission_id, task_id: integrator.id, kind: 'integration_failure', failure_class: signature, certainty: 'verified', details: { reason, responsible: responsible.map((r) => r.key) }, component: 'coordination', release_id: integrator.contract.release_id, source: kernel.sourceOf(integrator.mission_id) });
    store.emit({ type: 'integration_failed', mission_id: integrator.mission_id, task_id: integrator.id, actor_id: integrator.owner_id, actor_kind: 'agent', payload: { signature, reason: truncate(reason, 300), responsible: responsible.map((r) => r.key) } });
    for (const r of responsible) kernel.rejectTask(r.id, integrator.owner_id, reason, 'integration_failure');
    kernel.defer(integrator.id, integrator.owner_id, reason);
  }

  // ───────── independent acceptance verification ─────────

  /**
   * The verification swarm runs the protected acceptance suite against a clean checkout of the
   * integrated result. Delivery workers never see these tests.
   */
  async verify(task_id: string): Promise<void> {
    const { kernel, store, workspaces } = this.rt;
    let settle: (() => void) | null = null;
    await this.co.withLease(task_id, async (task) => {
      const m = store.missions.must(task.mission_id);
      const scenario = await this.co.scenario(m);
      const params = kernel.params(task.id) as { attribution: Record<string, string>; artifact_key: string };
      const targets = kernel.verificationTargets(task.id).map((id) => store.tasks.must(id));
      const summaries: string[] = [];
      const settlers: (() => void)[] = [];
      for (const target of targets) {
        if (!['submitted', 'verifying'].includes(target.status)) continue;
        kernel.setStatus(target.id, 'verifying', task.owner_id, { owner_id: task.owner_id, owner_kind: 'agent', action: `Independent verification of: ${target.title}`, since: store.clock.iso() });
        const version = kernel.currentVersion(m.id, params.artifact_key);
        if (!version || !version.content_ref.startsWith('git:') || !scenario.config.acceptance_dir) throw new SwarmError('nothing_to_verify', `no integrated result under ${params.artifact_key}`);
        const commit = version.content_ref.slice(4);
        const dir = workspaces.checkoutForVerification(m.id, commit, `g${target.generation}`);
        cpSync(join(scenario.dir, scenario.config.acceptance_dir), join(dir, 'acceptance'), { recursive: true });
        const run = await workspaces.run(dir, [...NODE_TEST, 'acceptance/**/*.test.ts'], 90_000);
        const evidence = this.recordRunEvidence(m, target, 'protected acceptance suite', run);
        const results = parseTap(run.stdout);
        const why = tapFailures(run.stdout);
        const notes: Record<string, string> = {};
        for (const c of target.contract.acceptance_criteria) {
          const mine = results.filter((r) => r.name.startsWith(`${c.criterion_id}:`));
          const verdict = mine.length === 0 ? 'inconclusive' : mine.every((r) => r.ok) ? 'pass' : 'fail';
          // What the failing check reported goes back to the author; the check's code does not.
          const said = why.filter((f) => f.name.startsWith(`${c.criterion_id}:`) && f.message).map((f) => f.message);
          if (said.length) notes[c.criterion_id] = said.join(' / ');
          kernel.recordVerification({ task_id: target.id, verifier_task_id: task.id, criterion_id: c.criterion_id, method: 'executable', verdict, verifier_id: task.owner_id, evidence_ids: [evidence], target_version_id: version.id, details: { tests: mine.map((r) => ({ name: r.name, ok: r.ok, ...(r.ok ? {} : { reported: why.find((f) => f.name === r.name)?.message ?? '' }) })), commit } });
          for (const need of store.needs.where('"mission_id" = ?', m.id).filter((n) => n.criterion_id === c.criterion_id)) {
            need.status = verdict === 'pass' ? 'satisfied' : 'mapped';
            store.needs.put(need);
          }
        }
        const failed = target.contract.acceptance_criteria.filter((c) => !results.filter((r) => r.name.startsWith(`${c.criterion_id}:`)).every((r) => r.ok) || !results.some((r) => r.name.startsWith(`${c.criterion_id}:`)));
        summaries.push(`${target.key}: ${target.contract.acceptance_criteria.length - failed.length}/${target.contract.acceptance_criteria.length} criteria pass at ${commit.slice(0, 10)}`);
        settlers.push(() => this.settleTarget(target.id, task, failed, params.attribution ?? {}, notes));
      }
      settle = () => settlers.forEach((s) => s());
      return { output: out(`Independent verification: ${summaries.join('; ') || 'nothing to verify'}`, { evidence: summaries.map((s) => ({ kind: 'verification', statement: s, epistemic: 'observed_fact' as const, origin: 'runtime' as const, refs: [] })) }) };
    });
    // The verifier's own result is recorded first; only then is the verified work accepted or sent back.
    const verifier = store.tasks.must(task_id);
    if (verifier.status === 'submitted') {
      kernel.acceptTask(task_id, VERIFIER_ID);
      (settle as (() => void) | null)?.();
    }
  }

  private settleTarget(target_id: string, verifier: Task, failed: AcceptanceCriterion[], attribution: Record<string, string>, notes: Record<string, string> = {}): void {
    const { kernel, store } = this.rt;
    const target = store.tasks.must(target_id);
    if (target.status !== 'verifying') return;
    const gaps = kernel.acceptanceGaps(target);
    if (gaps.length === 0) {
      kernel.acceptTask(target.id, verifier.owner_id);
      this.afterAccept(store.tasks.must(target.id));
      return;
    }
    const reason = truncate(`independent acceptance failed: ${gaps.map((g) => `${g.criterion_id} (${g.reason}${notes[g.criterion_id] ? `: ${notes[g.criterion_id]}` : ''})`).join('; ')}`, 1600);
    const keys = [...new Set(failed.map((c) => attribution[c.criterion_id]).filter((k): k is string => Boolean(k)))];
    const responsible = keys.map((k) => store.tasks.first('"mission_id" = ? AND "key" = ?', target.mission_id, k)).filter((t): t is Task => Boolean(t) && t!.status === 'accepted');
    kernel.observe({ mission_id: target.mission_id, task_id: target.id, kind: 'acceptance_failure', failure_class: failed.map((c) => c.criterion_id).sort().join('+') || 'unattributed', certainty: 'verified', details: { reason, responsible: responsible.map((r) => r.key) }, component: 'execution', release_id: target.contract.release_id, source: kernel.sourceOf(target.mission_id) });
    if (responsible.length === 0) {
      // Nobody can be named: this is a decision for the delivery lead, not something to guess at.
      kernel.rejectTask(target.id, verifier.owner_id, reason);
      return;
    }
    for (const r of responsible) kernel.rejectTask(r.id, verifier.owner_id, reason);
    kernel.defer(target.id, verifier.owner_id, reason);
  }

  // ───────── competing approaches ─────────

  /** Evidence-based selection among competing approaches. Agreement is not evidence; verified criteria are. */
  async select(task_id: string): Promise<void> {
    const { kernel, store, comms } = this.rt;
    await this.co.withLease(task_id, async (task) => {
      const m = store.missions.must(task.mission_id);
      const rivals = kernel.verificationTargets(task.id).map((id) => store.tasks.must(id)).filter((t) => ['submitted', 'verifying'].includes(t.status));
      if (rivals.length === 0) throw new SwarmError('nothing_to_select', 'no competing results were submitted');
      const scored: { task: Task; passed: number; total: number; evidence_ids: string[]; cost: number }[] = [];
      for (const r of rivals) {
        kernel.setStatus(r.id, 'verifying', task.owner_id);
        const vs = await this.evaluateCriteria(r, task.id);
        scored.push({ task: r, passed: vs.filter((v) => v.verdict === 'pass').length, total: r.contract.acceptance_criteria.length, evidence_ids: vs.flatMap((v) => v.evidence_ids), cost: kernel.budget.spent(r.budget_account_id).wall_ms });
      }
      scored.sort((a, b) => b.passed - a.passed || a.cost - b.cost || a.task.key.localeCompare(b.task.key));
      const decision = comms.openDecision({
        mission_id: m.id,
        task_id: task.id,
        kind: 'selection',
        question: `Which approach should be adopted for "${task.title}"?`,
        owner_id: task.owner_id,
        owner_kind: 'agent',
        options: scored.map((s) => ({ id: s.task.key, label: s.task.title, evidence_ids: s.evidence_ids, consequences: [`${s.passed}/${s.total} acceptance criteria verified`, `${s.cost} ms of worker time used`], proposed_by: s.task.owner_id })),
      });
      const winner = scored.find((s) => kernel.acceptanceGaps(store.tasks.must(s.task.id)).length === 0);
      if (!winner) {
        comms.escalate(decision.id, { owner_id: 'chief_of_staff', owner_kind: 'chief_of_staff' }, 'no approach satisfied every mandatory criterion');
        for (const s of scored) kernel.rejectTask(s.task.id, task.owner_id, 'no competing approach met every mandatory criterion');
        kernel.defer(task.id, task.owner_id, 'waiting for a competing approach that meets its criteria');
        return null;
      }
      comms.resolve({ command: 'resolveDecision', actor: task.owner_id, key: `select:${task.id}:g${task.generation}`, data: { decision_id: decision.id, chosen: winner.task.key, rationale: `Most acceptance criteria independently verified (${winner.passed}/${winner.total}); ties broken by lower resource use.` } });
      kernel.acceptTask(winner.task.id, task.owner_id);
      this.afterAccept(store.tasks.must(winner.task.id));
      for (const s of scored) {
        if (s.task.id === winner.task.id) continue;
        kernel.setStatus(s.task.id, 'not_selected', task.owner_id);
        kernel.budget.close(s.task.budget_account_id); // its artifacts are kept
      }
      return { output: out(`Selected ${winner.task.key} from ${scored.length} competing approaches on verified evidence`, { evidence: [{ kind: 'selection', statement: scored.map((s) => `${s.task.key}: ${s.passed}/${s.total}`).join(', '), epistemic: 'observed_fact', origin: 'runtime', refs: [decision.id] }] }) };
    });
  }

  // ───────── review packet ─────────

  async reviewPacket(task_id: string): Promise<void> {
    const { kernel, store, comms, workspaces } = this.rt;
    await this.co.withLease(task_id, async (task) => {
      const m = store.missions.must(task.mission_id);
      const tasks = store.tasks.where('"mission_id" = ?', m.id);
      const integrator = tasks.find((t) => t.executor === 'runtime:integrate');
      const criteriaOwner = integrator ?? tasks.find((t) => t.contract.acceptance_criteria.some((c) => c.mandatory));
      const acceptance: ReviewPacket['acceptance'] = [];
      for (const t of integrator ? [integrator] : tasks.filter((x) => x.executor !== 'container')) {
        const vs = store.verifications.where('"task_id" = ? AND "generation" = ?', t.id, t.generation);
        for (const c of t.contract.acceptance_criteria) {
          const latest = vs.filter((v) => v.criterion_id === c.criterion_id).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).at(-1);
          acceptance.push({ criterion_id: c.criterion_id, description: c.description, mandatory: c.mandatory, stakeholder: c.stakeholder, verdict: latest?.verdict ?? 'not verified', independent: latest?.independent ?? false, evidence_ids: latest?.evidence_ids ?? [] });
        }
      }
      let exact_changes: ReviewPacket['exact_changes'] = null;
      const integrated = integrator ? kernel.currentVersion(m.id, (kernel.params(integrator.id) as { output_key: string }).output_key) : undefined;
      if (integrated?.content_ref.startsWith('git:')) {
        const repo = workspaces.repoDir(m.id);
        const base = workspaces.git(repo, ['rev-list', '--max-parents=0', 'HEAD']);
        const head = integrated.content_ref.slice(4);
        exact_changes = { ref: 'integration', base_commit: base, head_commit: head, files: workspaces.changedFiles(repo, base, head) };
      }
      const needs = store.needs.where('"mission_id" = ?', m.id);
      const requests = m.request_ids.map((id) => store.requests.get(id)).filter((r): r is NonNullable<typeof r> => Boolean(r));
      // Ordered by what a reviewer must not miss: needs the result does not meet, then questions
      // only a person can settle, then what the workers themselves said they were unsure of.
      const concerns = new Set<string>();
      const who = (id: string): string => {
        const a = store.agents.get(id);
        return a ? `the ${a.role} (${a.archetype})` : id.replace(/_/g, ' ');
      };
      for (const n of needs.filter((x) => x.status !== 'satisfied')) concerns.add(`Stakeholder need not shown satisfied: ${n.stakeholder} — ${n.need}`);
      for (const q of comms.openQuestions(m.id)) concerns.add(`Open question from ${who(q.from_id)}: ${q.body}`);
      for (const t of tasks) for (const u of this.storedOutput(t)?.remaining_uncertainty ?? []) concerns.add(`Stated by the worker on ${t.key}: ${u}`);
      const spent = kernel.budget.spent(m.budget_account_id);
      const usages = store.attempts.where('"mission_id" = ?', m.id).map((a) => a.usage).filter((u): u is NonNullable<typeof u> => Boolean(u));
      const passed = acceptance.filter((a) => a.verdict === 'pass').length;
      const mandatoryOpen = acceptance.filter((a) => a.mandatory && a.verdict !== 'pass').length;
      const decision = comms.openDecision({
        mission_id: m.id,
        task_id: task.id,
        kind: 'outward_action',
        question: `Approve the integrated result of "${m.title}" for merge into the protected branch?`,
        owner_id: 'chief_of_staff',
        owner_kind: 'chief_of_staff',
        requires_human: true,
        options: [
          { id: 'approve', label: 'Approve the merge request draft', evidence_ids: acceptance.flatMap((a) => a.evidence_ids).slice(0, 20), consequences: ['The draft is marked approved. swarm_2 does not merge; the merge is performed through the existing protected path.', 'Reversible until that merge happens.'], proposed_by: 'runtime' },
          { id: 'request_changes', label: 'Send it back with corrections', evidence_ids: [], consequences: ['The correction is recorded as a human correction and work reopens.'], proposed_by: 'runtime' },
          { id: 'reject', label: 'Reject and close the mission', evidence_ids: [], consequences: ['Artifacts are kept; nothing is merged.'], proposed_by: 'runtime' },
        ],
      });
      const packet: ReviewPacket = {
        mission_id: m.id,
        title: m.title,
        cold_read: [
          `This packet covers "${m.title}". ${passed} of ${acceptance.length} acceptance criteria passed independent verification${mandatoryOpen ? `; ${mandatoryOpen} mandatory criteria did not` : ''}.${
            // A result must not read as covering a request it does not cover.
            ((left) => (left.length ? ` ${left.length} of the ${requests.length} requests this mission was authorized with ${left.length === 1 ? 'is' : 'are'} NOT covered by this result: ${left.map((n) => n.request_id).join(', ')}.` : ''))(needs.filter((n) => n.status === 'deferred' || n.status === 'open'))
          }`,
          'Decide whether to approve the merge request draft. Approval records your decision; it does not merge anything.',
        ],
        context: m.objective,
        requests: requests.map((r) => ({ id: r.id, stakeholder: r.stakeholder, team: r.team, text: r.text })),
        overlap: {
          shared_capability: store.getMeta<string>(`mission:${m.id}:shared_capability`) ?? m.title,
          distinct_needs: needs.map((n) => ({ stakeholder: n.stakeholder, need: n.need, criterion_id: n.criterion_id, status: n.status })),
        },
        exact_changes,
        acceptance,
        artifacts: store.versions.where('"mission_id" = ? AND "currency" = ?', m.id, 'current').filter((v) => !v.key.startsWith('evidence/')).map((v) => ({ key: v.key, version_no: v.version_no, content_hash: v.content_hash, currency: v.currency, kind: store.artifacts.must(v.artifact_id).kind })),
        decisions: store.decisions.where('"mission_id" = ?', m.id).filter((d) => d.id !== decision.id).map((d) => ({ id: d.id, question: d.question, chosen: d.chosen, owner_id: d.owner_id, status: d.status })),
        remaining_concerns: [...concerns],
        decision_requested: { decision_id: decision.id, question: decision.question, options: decision.options.map((o) => o.id), consequence: 'Approval marks the merge request draft approved. The merge itself stays with the existing protected path.', reversible: true },
        resource_use: { ...spent, cost_basis: usages.some((u) => u.cost_basis === 'list_price_estimate') ? 'list_price_estimate' : 'none', usage_completeness: usages.every((u) => u.completeness === 'complete') ? 'complete' : 'partial' },
        release_id: m.release_id,
        provider_mode: m.provider_mode,
        data_class: m.data_class,
        generated_at: store.clock.iso(),
      };
      const draft = comms.draft({
        mission_id: m.id,
        kind: 'merge.protected',
        audience: m.accountable_human,
        title: `Merge request: ${m.title}`,
        body: renderPacket(packet),
        context_refs: [decision.id, ...(criteriaOwner ? [criteriaOwner.id] : [])],
      });
      store.setMeta(`mission:${m.id}:review`, { decision_id: decision.id, draft_id: draft.id });
      return {
        output: out(`Review packet prepared: ${passed}/${acceptance.length} criteria verified; decision ${decision.id} awaits the chief of staff`, {
          artifacts: [
            { key: 'review/packet', kind: 'review_packet', media_type: 'application/json', content: JSON.stringify(packet, null, 2) },
            { key: 'review/packet.md', kind: 'review_packet', media_type: 'text/markdown', content: renderPacket(packet) },
          ],
          remaining_uncertainty: [],
        }),
      };
    });
  }
}

export function renderPacket(p: ReviewPacket): string {
  const lines: string[] = [];
  const label = p.provider_mode === 'fixture' ? 'DETERMINISTIC FIXTURE RUN' : 'LIVE MODEL EXECUTION';
  lines.push(`# Review packet: ${p.title}`, '', `> ${label} · ${p.data_class.toUpperCase()} DATA · release ${p.release_id}`, '', p.cold_read[0], p.cold_read[1], '');
  lines.push('## Context', '', p.context, '');
  if (p.requests.length) {
    const uncovered = new Set(p.overlap.distinct_needs.filter((n) => n.status === 'deferred' || n.status === 'open').map((n) => n.stakeholder));
    lines.push('## Requests this mission was authorized with', '');
    for (const r of p.requests) lines.push(`- **${r.team}** (${r.stakeholder}, \`${r.id}\`)${uncovered.has(r.stakeholder) ? ' — **not covered by this result**' : ''}: ${r.text}`);
    lines.push('', `Shared capability: ${p.overlap.shared_capability}`, '', '### Each stakeholder\'s need, kept distinct', '');
    for (const n of p.overlap.distinct_needs) lines.push(`- ${n.stakeholder}: ${n.need} → ${n.criterion_id ?? 'no criterion'} (${n.status === 'deferred' ? 'not covered by this mission' : n.status === 'open' ? 'not covered: no criterion was written for it' : n.status})`);
    lines.push('');
  }
  lines.push('## Exact changes', '');
  if (p.exact_changes) {
    lines.push(`Base \`${p.exact_changes.base_commit?.slice(0, 10)}\` → head \`${p.exact_changes.head_commit?.slice(0, 10)}\` on \`${p.exact_changes.ref}\``, '');
    for (const f of p.exact_changes.files) lines.push(`- ${f.status} ${f.path}`);
  } else lines.push('No code changes.');
  lines.push('', '## Acceptance evidence', '', '| Criterion | For | Verdict | Independent | Evidence |', '|---|---|---|---|---|');
  for (const a of p.acceptance) lines.push(`| ${a.criterion_id}: ${a.description} | ${a.stakeholder ?? 'all'} | ${a.verdict} | ${a.independent ? 'yes' : 'no'} | ${a.evidence_ids.join(', ') || 'none'} |`);
  lines.push('', '## Remaining concerns', '');
  if (p.remaining_concerns.length) for (const c of p.remaining_concerns) lines.push(`- ${c}`);
  else lines.push('None recorded.');
  lines.push('', '## Decision requested', '', p.decision_requested.question, '', `Options: ${p.decision_requested.options.join(', ')}.`, p.decision_requested.consequence, '');
  lines.push('## Resource use', '', `- Worker invocations: ${p.resource_use.worker_invocations}`, `- Model calls: ${p.resource_use.model_calls}`, `- Tokens: ${p.resource_use.tokens}`, `- Cost: ${p.resource_use.cost_basis === 'none' ? 'not measured' : `${p.resource_use.cost_usd_est} USD (${p.resource_use.cost_basis}, not billing)`}`, `- Worker wall time: ${p.resource_use.wall_ms} ms`, '');
  return lines.join('\n');
}

export type { Token };
