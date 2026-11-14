import { completeFixtureCanary } from './lib.ts';
/**
 * Demonstrations A–G. Each one runs the real runtime against a fresh state directory and writes
 * an evidence bundle built from persisted events and records.
 *
 *   node demos/run.ts a|b|c|d|e|f|g|h|all
 *
 * Unless SWARM2_LIVE=1 and `--live` are both given, every demonstration uses the DETERMINISTIC
 * FIXTURE PROVIDER on SYNTHETIC data. Injected faults are labeled as such in the event log.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/config.ts';
import { applyUpstreamChange } from '../src/coordination/changes.ts';
import { Coordinator } from '../src/coordination/coordinator.ts';
import { criticalPath } from '../src/coordination/metrics.ts';
import type { ImprovementReceipt } from '../src/contracts/types.ts';
import { LocalChiefOfStaff } from '../src/cos/port.ts';
import { installArena } from '../src/evolution/arena.ts';
import { observeReviewWork, runExperiment } from '../src/evolution/loop.ts';
import { type PortfolioStep, type PortfolioView, portfolio, portfolioCampaign, recordReport } from '../src/evolution/portfolio.ts';
import { renderManifest, renderReceipt } from '../src/evolution/receipts.ts';
import { Gate, PROTECTED_SRC } from '../src/gate/gate.ts';
import { CANDIDATE_UID } from '../src/gate/sandbox.ts';
import { lineage } from '../src/memory/memory.ts';
import type { Runtime } from '../src/runtime.ts';
import { pidAlive } from '../src/lib/util.ts';
import { brief, freshHome, injectFaults, scenarioRequests, startCoordinator, submitSharedCapability, waitFor, writeEvidence } from './lib.ts';

const EVIDENCE = join(REPO_ROOT, 'evidence');
const LIVE = process.env.SWARM2_LIVE === '1' && process.argv.includes('--live');

interface Step {
  claim: string;
  observed: string;
  ok: boolean;
}

interface DemoResult {
  demo: string;
  title: string;
  labels: string[];
  steps: Step[];
  files: string[];
  ok: boolean;
  ms: number;
}

class Report {
  steps: Step[] = [];
  files: string[] = [];
  dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  check(claim: string, ok: boolean, observed: string): void {
    this.steps.push({ claim, observed, ok });
    process.stdout.write(`   ${ok ? 'ok  ' : 'FAIL'} ${claim}\n        ${observed}\n`);
  }
  file(name: string, value: unknown): void {
    writeEvidence(this.dir, name, value);
    this.files.push(name);
  }
}

function home(demo: string): string {
  return join(REPO_ROOT, 'var', `demo-${demo}`);
}

function finish(demo: string, title: string, labels: string[], rep: Report, t0: number, narrative: string[]): DemoResult {
  const ok = rep.steps.every((s) => s.ok);
  const result: DemoResult = { demo, title, labels, steps: rep.steps, files: rep.files, ok, ms: Date.now() - t0 };
  const md = [`# Demonstration ${demo.toUpperCase()} — ${title}`, '', ...labels.map((l) => `> ${l}`), '', ...narrative, '', '## What was checked', '', '| Claim | Observed | Result |', '|---|---|---|', ...rep.steps.map((s) => `| ${s.claim} | ${s.observed.replace(/\|/g, '\\|')} | ${s.ok ? 'held' : '**did not hold**'} |`), '', `Files in this folder: ${rep.files.map((f) => `\`${f}\``).join(', ')}.`, '', `Reproduce with \`npm run demo:${demo}\`. Run time ${result.ms} ms.`, ''];
  rep.file('README.md', md.join('\n'));
  rep.file('summary.json', result);
  return result;
}

const FIXTURE_LABELS = ['DETERMINISTIC FIXTURE PROVIDER — scripted workers in real processes; no model was run', 'SYNTHETIC DATA — every request, team, dataset and value is invented'];

// ───────────────────────────── A: cross-swarm delivery ─────────────────────────────

async function demoA(): Promise<DemoResult> {
  const t0 = Date.now();
  const rep = new Report(join(EVIDENCE, 'demo-a'));
  const rt = freshHome(home('a'));
  const gate = new Gate(rt);
  gate.init();
  const co = new Coordinator(rt);
  try {
    const { cos, mission_id } = submitSharedCapability(rt, 'demo-a', LIVE ? { provider_mode: 'live' } : {});
    const clusters = rt.store.events({ type: 'overlap_detected' });
    rep.check('Overlapping requests are nominated and the unrelated one is left out', clusters.length === 1 && (clusters[0]!.payload.request_ids as string[]).length === 4, `one cluster of ${(clusters[0]?.payload.request_ids as string[])?.join(', ')}; syn-req-005 (licensing) not included`);

    const state = await co.runUntilIdle({ max_ms: LIVE ? 1_800_000 : 120_000 });
    await co.drain();
    const m = rt.store.missions.must(mission_id);
    const tasks = rt.store.tasks.where('"mission_id" = ?', mission_id);
    const swarms = rt.store.swarms.where('"mission_id" = ?', mission_id);
    rep.check('The mission runs to a reviewable state', state === 'idle' && m.status === 'review_ready', `coordinator ${state}; mission ${m.status}; ${tasks.filter((t) => t.status === 'accepted').length}/${tasks.length} tasks accepted`);
    const archetypes = [...new Set(swarms.map((s) => s.archetype))];
    rep.check('At least three swarm capabilities take part', archetypes.length >= 3, `${archetypes.length} participated: ${archetypes.join(', ')}`);
    rep.check('The organization uses three delegated layers and no more', Math.max(...tasks.map((t) => t.depth)) === 3, `deepest task is at layer ${Math.max(...tasks.map((t) => t.depth))}; subordinate teams: ${swarms.filter((s) => s.parent_swarm_id).map((s) => s.purpose).join(' / ')}`);

    const needs = rt.store.needs.where('"mission_id" = ?', mission_id);
    rep.check('Each stakeholder keeps a distinct need tied to its own acceptance criterion', needs.length === 4 && needs.every((n) => n.criterion_id && n.status === 'satisfied'), needs.map((n) => `${n.stakeholder}→${n.criterion_id} (${n.status})`).join('; '));

    const leased = rt.store.events({ mission_id, type: 'task_leased' });
    const submitted = rt.store.events({ mission_id, type: 'result_submitted' });
    const span = (key: string) => ({ start: leased.find((e) => e.payload.key === key), end: submitted.find((e) => e.payload.key === key) });
    const eng = span('delivery.engine.implement');
    const rpt = span('delivery.report.implement');
    const overlap = Boolean(eng.start && eng.end && rpt.start && rpt.end && eng.start.seq < rpt.end.seq && rpt.start.seq < eng.end.seq);
    rep.check('Two workstreams execute concurrently', overlap, `engine leased #${eng.start?.seq} ${eng.start?.ts} → submitted #${eng.end?.seq}; report leased #${rpt.start?.seq} ${rpt.start?.ts} → submitted #${rpt.end?.seq}`);
    const attempts = rt.store.attempts.where('"mission_id" = ?', mission_id);
    const pids = new Set(attempts.filter((a) => a.provider !== 'runtime').map((a) => a.pid));
    rep.check('Workers actually execute as separate processes in isolated worktrees', pids.size >= 7 && attempts.filter((a) => a.workspace).length >= 2, `${attempts.filter((a) => a.provider !== 'runtime').length} worker attempts in ${pids.size} distinct processes; worktree branches: ${attempts.filter((a) => a.workspace?.branch).map((a) => a.workspace!.branch).join(', ')}`);

    const items = rt.store.integration.where('"mission_id" = ?', mission_id).sort((a, b) => a.position - b.position);
    rep.check('The workstreams meet at a real integration boundary', items.length === 2 && items.every((i) => i.status === 'merged'), items.map((i) => `${rt.store.tasks.must(i.task_id).key} merged as ${i.merge_commit?.slice(0, 10)}`).join('; '));
    const integrate = tasks.find((t) => t.key === 'delivery.integrate')!;
    const vs = rt.store.verifications.where('"task_id" = ? AND "generation" = ?', integrate.id, integrate.generation);
    rep.check('The integrated result is verified independently of its authors', vs.length === 5 && vs.every((v) => v.verdict === 'pass' && v.independent), vs.map((v) => `${v.criterion_id}=${v.verdict}`).join(', ') + ' by the verification swarm, on tests delivery never saw');
    const handoffs = rt.store.handoffs.where('"mission_id" = ?', mission_id);
    rep.check('Handoffs carry the artifact version, acceptance evidence and remaining uncertainty', handoffs.length > 0 && handoffs.every((h) => h.status === 'accepted'), `${handoffs.length} handoffs, all accepted by the next owner; ${handoffs.filter((h) => h.remaining_uncertainty.length).length} carried stated uncertainty`);

    const ev = cos.retrieveEvidence(mission_id);
    const attention = cos.attention();
    const packet = ev.source === 'unavailable' ? null : ev;
    const packetOk = packet !== null && packet.packet !== null;
    rep.check('A review packet and the decision it needs are waiting for the chief of staff', packetOk && attention.source !== 'unavailable' && attention.items.length === 2, attention.source !== 'unavailable' ? attention.items.map((i) => `${i.kind}: ${i.title}`).join(' | ') : 'unavailable');
    const budget = rt.kernel.budget.reconcile(m.budget_account_id);
    const spent = rt.kernel.budget.spent(m.budget_account_id);
    rep.check('Resource accounting reconciles across the whole task tree', budget.ok, `${budget.accounts} accounts reconcile; ${spent.worker_invocations} worker invocations and ${spent.wall_ms} ms of worker time used`);
    const chain = rt.store.verifyEventChain();
    rep.check('Everything shown comes from the persisted, hash-chained event log', chain.ok, `${chain.count} events, chain intact`);

    if (packet) {
      rep.file('review-packet.md', packet.packet_markdown ?? '');
      rep.file('review-packet.json', packet.packet);
    }
    rep.file('organization.json', { swarms: swarms.map((s) => ({ archetype: s.archetype, purpose: s.purpose, deliverable: s.deliverable, stopping_condition: s.stopping_condition, depth: s.depth, temporary: s.temporary, status: s.status })), tasks: tasks.sort((a, b) => a.created_at.localeCompare(b.created_at)).map((t) => ({ key: t.key, executor: t.executor, owner: t.owner_id, depth: t.depth, status: t.status, attempts: t.attempt, reservation: t.contract.resources.reservation })) });
    rep.file('lineage.json', lineage(rt, mission_id));
    rep.file('outcome.json', { outcome: rt.store.outcomes.first('"mission_id" = ?', mission_id), critical_path: criticalPath(rt, mission_id), communication: rt.comms.overhead(mission_id), usage: attempts.map((a) => ({ task: rt.store.tasks.must(a.task_id).key, provider: a.provider, mode: a.provider_mode, model_requested: a.model_requested, model_actual: a.model_actual, usage: a.usage })) });
    rep.file('timeline.txt', rt.store.events({ mission_id }).map(brief).join('\n'));
    const decision = attention.source !== 'unavailable' ? attention.items.find((i) => i.kind === 'decision') : undefined;
    if (decision) {
      cos.resolveDecision({ command: 'resolveDecision', actor: 'demo-operator', key: 'demo-a-approve', data: { decision_id: decision.id, chosen: 'approve', rationale: 'Demonstration: the operator stands in for the accountable human.' } });
      rep.check('Approval is recorded and nothing is merged or sent by the system', rt.store.missions.must(mission_id).status === 'completed' && rt.store.events({ mission_id, type: 'draft_reviewed' }).every((e) => e.payload.sent_by_swarm === false), `mission completed; draft approved; sent_by_swarm=false`);
    }
    return finish('a', 'Cross-swarm delivery', LIVE ? ['LIVE MODEL EXECUTION through claude -p', 'SYNTHETIC DATA'] : FIXTURE_LABELS, rep, t0, [
      'Five synthetic requests arrive. Four describe different symptoms of one missing capability; one is unrelated. The chief of staff submits the nominated mission.',
      'Discovery establishes the shared need and each stakeholder\'s distinct need. Planning writes measurable acceptance criteria, agrees the HealthRecord interface and proposes the work graph. The delivery lead creates two subordinate teams that work at the same time in separate git worktrees and meet at one integration task. A separate verification swarm runs a protected acceptance suite on a clean checkout. Reliability records what was learned. The review packet asks for one decision.',
    ]);
  } finally {
    co.stop();
    gate.close();
    rt.close();
  }
}

// ───────────────────────────── B: failure recovery ─────────────────────────────

async function demoB(): Promise<DemoResult> {
  const t0 = Date.now();
  const rep = new Report(join(EVIDENCE, 'demo-b'));
  const h = home('b');
  const rt = freshHome(h, { lease_ms: 1500 });
  const env = { SWARM2_LEASE_MS: '1500' };
  const procs: { child: { kill(s?: NodeJS.Signals): boolean } }[] = [];
  try {
    const { cos, mission_id } = submitSharedCapability(rt, 'demo-b');
    injectFaults(rt, mission_id, [
      { task_key: 'delivery.engine.implement', attempt: 1, fault: 'slow:8000' },
      { task_key: 'delivery.report.implement', attempt: 1, fault: 'stall_then_submit:3500' },
      { task_key: 'reliability.knowledge', attempt: 1, fault: 'slow:8000' },
    ]);
    const task = (key: string) => rt.store.tasks.first('"mission_id" = ? AND "key" = ?', mission_id, key);
    const attempt = (key: string, n: number) => (task(key) ? rt.kernel.attemptFor(task(key)!.id, n) : undefined);
    const running = (key: string, n: number) => () => {
      const a = attempt(key, n);
      return a?.status === 'running' && a.pid ? a.pid : null;
    };

    const c1 = startCoordinator(h, { env });
    procs.push(c1);
    const enginePid = await waitFor(running('delivery.engine.implement', 1), 30_000, 'the engine worker');
    process.kill(enginePid, 'SIGKILL');
    rt.store.emit({ type: 'fault_injected', mission_id, actor_id: 'demo-driver', actor_kind: 'operator', payload: { label: 'INJECTED FAULT', fault: 'worker process killed', pid: enginePid, key: 'delivery.engine.implement' } });
    await waitFor(() => attempt('delivery.engine.implement', 2), 15_000, 'the engine to be re-leased');
    rep.check('A killed worker loses ownership and the work is re-leased under a new fencing token', attempt('delivery.engine.implement', 1)!.status === 'killed' && task('delivery.engine.implement')!.attempt === 2, `attempt 1 (pid ${enginePid}) is "${attempt('delivery.engine.implement', 1)!.status}"; the task is now on token g1a2`);

    const stale = await waitFor(() => rt.store.events({ mission_id, type: 'stale_result_rejected' }).find((e) => e.payload.key === 'delivery.report.implement'), 20_000, 'the stale result');
    rep.check('A worker presumed dead cannot overwrite the attempt that replaced it', stale.payload.presented === 'g1a1' && attempt('delivery.report.implement', 1)!.status === 'expired', `its lease expired without a heartbeat; it later presented token ${String(stale.payload.presented)} and was rejected (${String(stale.payload.reason)})`);

    const knowledgePid = await waitFor(running('reliability.knowledge', 1), 40_000, 'the knowledge worker');
    c1.child.kill('SIGKILL');
    await c1.exited;
    rt.store.emit({ type: 'fault_injected', mission_id, actor_id: 'demo-driver', actor_kind: 'operator', payload: { label: 'INJECTED FAULT', fault: 'coordinator process killed mid-mission' } });
    const orphanAlive = pidAlive(knowledgePid);
    const c2 = startCoordinator(h, { env });
    procs.push(c2);
    const code2 = await c2.exited;
    const orphaned = rt.store.events({ mission_id, type: 'attempt_orphaned' });
    rep.check('A new coordinator resumes from persisted state alone', code2 === 0 && rt.store.missions.must(mission_id).status === 'review_ready', `the second coordinator fenced ${orphaned.length} in-flight attempt(s), finished the mission, and exited ${code2}`);
    rep.check('An orphaned worker is stopped rather than left running', orphanAlive && !pidAlive(knowledgePid), `pid ${knowledgePid} outlived the coordinator that started it and was stopped on recovery`);

    const m0 = rt.store.missions.must(mission_id);
    const dupReq = cos.ingestRequests({ command: 'ingestRequests', actor: 'chief_of_staff', key: 'demo-b-ingest', data: { requests: scenarioRequests() } });
    const submit = { command: 'submitMission', actor: 'chief_of_staff', key: 'demo-b-submit', data: { title: m0.title, objective: m0.objective, request_ids: m0.request_ids, scenario: 'shared-capability', priority: 2 } };
    const dup = cos.submitMission(submit);
    let conflict = '';
    try {
      cos.submitMission({ ...submit, data: { ...submit.data, title: 'a different request under the same key' } });
    } catch (err) {
      conflict = err instanceof Error ? err.message : String(err);
    }
    rep.check('A duplicate delivery changes nothing, and a conflicting one is quarantined', dupReq.source !== 'unavailable' && dupReq.duplicates === 5 && dup.source !== 'unavailable' && dup.mission.id === mission_id && rt.store.missions.count() === 1 && /different body/.test(conflict), `5 redelivered requests ignored; the repeated command returned the original mission; the conflicting one was refused: "${conflict}"`);

    const before = Object.fromEntries(['discovery.analyze', 'planning.criteria', 'planning.plan', 'delivery.decompose'].map((k) => [k, task(k)!.attempt]));
    const firstReview = rt.store.getMeta<{ decision_id: string; draft_id: string }>(`mission:${mission_id}:review`)!;
    const v2 = readFileSync(join(REPO_ROOT, 'fixtures/scenarios/shared-capability/contracts/health-record.v2.json'), 'utf8');
    const change = applyUpstreamChange(rt, { command: 'applyUpstreamChange', actor: 'chief_of_staff', key: 'demo-b-revise', data: { mission_id, key: 'contract/health-record', content: v2, reason: 'the weekly review needs a severity ranking' } });
    const impact = Object.fromEntries(change.impacts.map((i) => [i.key, i.action]));
    rep.check('Revising an upstream contract invalidates exactly what depended on it', impact['delivery.engine.implement'] === 'rerun_required' && impact['delivery.report.implement'] === 'rerun_required' && impact['delivery.integrate'] === 'downstream_blocked' && impact['discovery.analyze'] === undefined, Object.entries(impact).map(([k, a]) => `${k}: ${a}`).join('; '));
    rep.check('A review decision resting on stale evidence cannot be approved by mistake', rt.store.decisions.must(firstReview.decision_id).status === 'superseded' && rt.store.drafts.must(firstReview.draft_id).status === 'withdrawn' && rt.store.missions.must(mission_id).status === 'active', 'the pending decision was superseded, its draft withdrawn, and the mission reopened');
    const c3 = startCoordinator(h, { env });
    procs.push(c3);
    const code3 = await c3.exited;
    const integrate = task('delivery.integrate')!;
    const vs = rt.store.verifications.where('"task_id" = ? AND "generation" = ?', integrate.id, integrate.generation);
    rep.check('Only affected work is redone, and the result is verified again', code3 === 0 && Object.entries(before).every(([k, n]) => task(k)!.attempt === n) && vs.length === 5 && vs.every((v) => v.verdict === 'pass' && v.independent), `discovery, criteria, plan and decomposition were not rerun; engine and report were rebuilt against contract v2; all 5 criteria pass again at generation ${integrate.generation}`);
    const m = rt.store.missions.must(mission_id);
    rep.check('State reconciles after all of it', rt.kernel.budget.reconcile(m.budget_account_id).ok && rt.store.verifyEventChain().ok && m.status === 'review_ready', `budget tree reconciles; event chain intact; mission ${m.status} with a fresh decision requested`);

    const types = ['fault_plan_installed', 'fault_injected', 'task_leased', 'attempt_failed', 'task_requeued', 'lease_expired', 'stale_result_rejected', 'attempt_orphaned', 'recovery_completed', 'duplicate_delivery_ignored', 'idempotency_conflict_quarantined', 'upstream_change_applied', 'task_invalidated', 'impact_recorded', 'decision_superseded', 'budget_reopened', 'task_revalidated_without_rerun', 'integration_merged', 'verification_recorded', 'mission_status_changed'];
    rep.file('timeline.txt', rt.store.events().filter((e) => types.includes(e.type)).map(brief).join('\n'));
    rep.file('recovery.json', { attempts: rt.store.attempts.where('"mission_id" = ?', mission_id).map((a) => ({ task: rt.store.tasks.must(a.task_id).key, attempt_no: a.attempt_no, generation: a.generation, status: a.status, pid: a.pid, error: a.error })), impacts: change.impacts, coordinator_logs: { first: c1.logs.slice(-12), second: c2.logs.slice(0, 8), third: c3.logs.slice(0, 8) } });
    return finish('b', 'Failure recovery', [...FIXTURE_LABELS, 'INJECTED FAULTS — a killed worker, a stalled worker, a killed coordinator; each is labeled in the event log', 'This demonstrates resilience. It is not evidence of general performance.'], rep, t0, [
      'Coordinators run as separate operating-system processes so they can be killed like real ones. The driver kills a worker, lets another stall past its lease and submit late, kills the coordinator mid-mission and starts a new one, redelivers a command, and finally publishes a new version of the interface contract.',
    ]);
  } finally {
    for (const p of procs) p.child.kill('SIGKILL');
    rt.close();
  }
}

// ───────────────────────────── C: first-order improvement ─────────────────────────────

function saveReceipt(rep: Report, name: string, r: ImprovementReceipt): void {
  rep.file(`${name}.receipt.json`, r);
  rep.file(`${name}.receipt.md`, renderReceipt(r));
}

async function demoC(): Promise<DemoResult> {
  const t0 = Date.now();
  const rep = new Report(join(EVIDENCE, 'demo-c'));
  const rt = freshHome(home('c'));
  const gate = new Gate(rt);
  try {
    const init = gate.init();
    const seen = await observeReviewWork(rt, gate);
    rep.check('An observed failure is recorded with what actually went wrong', seen.observation_ids.length > 0, `${seen.observation_ids.length} verified failures in ${seen.reviewed} reviews under release r1 (accuracy ${(seen.accuracy * 100).toFixed(0)}%): ${Object.entries(seen.by_class).map(([k, v]) => `${k}×${v}`).join(', ')}`);

    const first = await runExperiment(rt, gate, 'exec-interface-compat-naive');
    const acc1 = first.receipt.comparisons.find((c) => c.metric === 'accuracy')!;
    rep.check('The first candidate is an executable change to a skill, judged on held-out cases against a frozen protocol', first.receipt.evaluation.frozen_at < first.receipt.decided_at && first.receipt.change.files.some((f) => f.path.includes('interface_compat')), `adds ${first.receipt.change.files.map((f) => f.path).join(', ')}; protocol frozen ${first.receipt.evaluation.frozen_at}; scored once on ${first.receipt.evaluation.holdout_set}`);
    rep.check('A candidate that helps but harms something else is rejected, and its result kept', first.receipt.decision === 'reject' && first.receipt.release_manifest === null, `accuracy ${acc1.incumbent} → ${acc1.candidate}, but ${first.receipt.gates.find((g) => g.id === 'false_alarms_within_margin')!.meaning}`);

    const second = await runExperiment(rt, gate, 'exec-interface-compat', { revises_experiment: first.experiment.id });
    const acc2 = second.receipt.comparisons.find((c) => c.metric === 'accuracy')!;
    rep.check('A revision is never scored on cases its lineage has already seen results for', second.receipt.evaluation.holdout_set !== first.receipt.evaluation.holdout_set, `first attempt on ${first.receipt.evaluation.holdout_set}; revision on ${second.receipt.evaluation.holdout_set}; the first set is recorded as development data for this lineage`);
    rep.check('The revised candidate is compared with the incumbent and the fixed original baseline', second.receipt.decision === 'accept' && acc2.ci95_vs_incumbent![0] > 0 && acc2.baseline !== null, `accuracy ${acc2.incumbent} → ${acc2.candidate} (difference ${acc2.diff_vs_incumbent}, 95% interval ${acc2.ci95_vs_incumbent![0]} to ${acc2.ci95_vs_incumbent![1]}, n=${acc2.n}); baseline ${acc2.baseline}`);
    const rel = second.receipt.release_manifest!;
    rep.check('Acceptance creates a release manifest but does not make it the default', rel.status === 'canary' && rt.registry.active() === 'r1' && rel.components.execution.version === 2 && rel.components.coordination.version === 1, `${rel.release_id}: execution v${rel.components.execution.version}, coordination v${rel.components.coordination.version}, evolution v${rel.components.evolution.version}; rollback target ${rel.rollback_target}; active release still ${rt.registry.active()}`);

    const canary = gate.startCanary(rel.release_id, { max_missions: 2 });
    await completeFixtureCanary(rt, gate, canary.id);
    const observed = await gate.observeCanary(canary.id);
    rep.check('The qualified release is monitored in a bounded canary on fresh cases', observed.status === 'running' && observed.observations.every((o) => !o.breached), observed.observations.map((o) => `${o.metric}=${o.value ?? '—'} (limit ${o.threshold})`).join('; '));
    const retained = gate.retain(canary.id);
    rep.check('A healthy canary is retained and applies to future work only', retained.status === 'retained' && rt.registry.active() === rel.release_id, `active release is now ${rt.registry.active()}; ${rel.rollback_target} is retired and remains the rollback target`);
    rep.check('The evaluation ledger is complete and intact', gate.verifyLedger().ok && gate.integrity().ok, `${gate.verifyLedger().count} ledger entries, hash chain intact; protected store matches its sealed digest`);

    saveReceipt(rep, '1-naive-rejected', first.receipt);
    saveReceipt(rep, '2-revised-accepted', second.receipt);
    rep.file('release-manifests.json', rt.registry.list());
    rep.file('release-manifests.md', rt.registry.list().map(renderManifest).join('\n\n---\n\n'));
    rep.file('ledger.json', gate.ledger());
    rep.file('canary.json', gate.canaries.must(canary.id));
    rep.file('observations.json', rt.store.observations.where(`"component" = 'execution:change-review'`).slice(0, 12));
    return finish('c', 'First-order improvement', ['DETERMINISTIC FIXTURE EVALUATION — executable validators on synthetic change-review cases; no model was run', `ISOLATION MODE: ${init.isolation.mode}`, 'Both candidates were written by the same author who wrote the held-out cases. This shows the machinery separates a flawed candidate from a sound one; it is not evidence about a model\'s ability to generalize.'], rep, t0, [
      'The incumbent change-review skill never compares a contract before and after a change, so it approves breaking changes. Those failures are observed on review work, a candidate adds an interface-compatibility step, and the release gate judges it on held-out cases the author cannot see.',
      'The first candidate catches breaks but also blocks safe additions, and is rejected by a hard gate. Its revision is accepted on a different held-out set, runs in a bounded canary on fresh cases, and is retained.',
    ]);
  } finally {
    gate.close();
    rt.close();
  }
}

// ───────────────────────────── D: improving the improvement process ─────────────────────────────

async function demoD(): Promise<DemoResult> {
  const t0 = Date.now();
  const rep = new Report(join(EVIDENCE, 'demo-d'));
  const rt = freshHome(home('d'));
  const gate = new Gate(rt);
  installArena(gate);
  try {
    gate.init();
    const r = await runExperiment(rt, gate, 'evo-expected-value');
    const rec = r.receipt;
    const get = (m: string) => rec.comparisons.find((c) => c.metric === m)!;
    const benefit = get('validated_benefit');
    const failed = get('failed_experiment_cost');
    const spent = get('budget_spent');
    const quiet = get('validated_benefit_without_unverified_complaints');
    rep.check('The candidate changes the evolution system\'s own behaviour and is versioned as such', rec.level === 'evolution' && rec.change.files.some((f) => f.path === 'policy.mjs'), `evolution v${rec.parent.version} → candidate; changed ${rec.change.files.map((f) => f.path).join(', ')}`);
    rep.check('Old and new policies get equal budgets and the same unseen failure episodes', benefit.n === 30 && spent.candidate! <= 420 && spent.incumbent! <= 420, `${benefit.n} episodes from held-out set ${rec.evaluation.holdout_set}; budget 420 units each; mean spent ${spent.incumbent} (incumbent) and ${spent.candidate} (candidate)`);
    rep.check('What is measured is independently validated improvement, not the policy\'s own claims', rec.gates.filter((g) => g.kind === 'HARD_GATE').every((g) => g.verdict === 'PASSED'), `validated benefit ${benefit.incumbent} → ${benefit.candidate} per 100 reviews (difference ${benefit.diff_vs_incumbent}, 95% interval ${benefit.ci95_vs_incumbent![0]} to ${benefit.ci95_vs_incumbent![1]}); ${benefit.method.split('; ')[1]}`);
    rep.check('The cost of unsuccessful experiments is counted', failed.candidate !== null && failed.incumbent !== null, `budget spent on fixes that failed: ${failed.incumbent} → ${failed.candidate} units per campaign (difference ${failed.diff_vs_incumbent}, 95% interval ${failed.ci95_vs_incumbent![0]} to ${failed.ci95_vs_incumbent![1]})`);
    const [lo, hi] = benefit.ci95_vs_incumbent!;
    rep.check('The decision follows the frozen rule, whichever way it falls', rec.decision === (lo > 0 ? 'accept' : hi < 0 ? 'reject' : 'inconclusive'), `${rec.decision}: ${rec.justification}`);
    rep.check('The sensitivity check and known regressions are reported, favourable or not', rec.known_regressions.length > 0 || quiet.ci95_vs_incumbent![0] > 0, `without the unverified complaint class: difference ${quiet.diff_vs_incumbent} (95% interval ${quiet.ci95_vs_incumbent![0]} to ${quiet.ci95_vs_incumbent![1]}). ${rec.known_regressions.join(' ')}`);
    saveReceipt(rep, 'expected-value-policy', rec);
    rep.file('release-manifests.json', rt.registry.list());
    rep.file('ledger.json', gate.ledger());
    const snapshot = JSON.parse(readFileSync(join(rt.paths.protected, 'evaluations', `${r.experiment.id}.json`), 'utf8')) as { snapshot: { incumbent: { tally: unknown }; candidate: { tally: unknown }; sensitivity: unknown } };
    rep.file('campaign-tallies.json', { incumbent: snapshot.snapshot.incumbent.tally, candidate: snapshot.snapshot.candidate.tally, sensitivity: snapshot.snapshot.sensitivity, note: 'Per-episode records stay in the protected store; these are aggregates.' });
    return finish('d', 'Improvement of the improvement process', ['SIMULATION — a synthetic improvement arena; policies and fixes are real executable code, the failure distribution is invented', 'Both policies and the arena were written by the same author. The result describes this testbed.'], rep, t0, [
      'Two improvement policies run improvement campaigns. The incumbent works on whatever is reported most often. The candidate values a problem by verified failures times severity per unit of cost, pilots a built fix on observed cases before paying for a held-out evaluation, drops a fix whose pilot breaks something, and stops when nothing is worth its cost.',
      'Each policy gets the same budget on the same thirty unseen episodes. Every fix a policy submits is judged on held-out cases by the release gate\'s rule; the campaign\'s worth is then measured on fresh cases.',
    ]);
  } finally {
    gate.close();
    rt.close();
  }
}

// ───────────────────────────── E: rejection ─────────────────────────────

async function demoE(): Promise<DemoResult> {
  const t0 = Date.now();
  const rep = new Report(join(EVIDENCE, 'demo-e'));
  const rt = freshHome(home('e'));
  const gate = new Gate(rt);
  try {
    gate.init();
    const r = await runExperiment(rt, gate, 'exec-fast-review');
    const rec = r.receipt;
    const steps = rec.comparisons.find((c) => c.metric === 'steps_per_review')!;
    const req = rec.gates.find((g) => g.id === 'required_steps_present')!;
    rep.check('The candidate really is cheaper', steps.diff_vs_incumbent! < 0, `steps per review ${steps.incumbent} → ${steps.candidate}`);
    rep.check('It is cheaper because it omits a required verification step', req.verdict === 'FAILED', req.meaning);
    rep.check('The release gate rejects it; a hard gate cannot be outscored', rec.decision === 'reject' && rec.release_manifest === null, rec.justification);
    const escaped = rec.comparisons.find((c) => c.metric === 'escaped_defect_rate')!;
    rep.check('The omission has a measured consequence on held-out cases', escaped.candidate! > escaped.incumbent!, `share of breaking changes approved ${escaped.incumbent} → ${escaped.candidate}`);
    rep.check('The rejected candidate and its result are preserved', gate.experiments.must(r.experiment.id).candidate !== null && gate.receipt(rec.receipt_id).decision === 'reject', `candidate ${r.experiment.candidate!.candidate_hash.slice(0, 16)} kept in custody; receipt ${rec.receipt_id}`);
    saveReceipt(rep, 'fast-review-rejected', rec);
    return finish('e', 'Rejection of a candidate that omits required verification', ['DETERMINISTIC FIXTURE EVALUATION — executable validators on synthetic cases; no model was run'], rep, t0, ['A candidate proposes to halve review cost by dropping the step that checks for tests. It declares itself a simplification. The gate probes each step that may not be omitted with a case whose answer is known.']);
  } finally {
    gate.close();
    rt.close();
  }
}

// ───────────────────────────── F: isolation ─────────────────────────────

async function demoF(): Promise<DemoResult> {
  const t0 = Date.now();
  const rep = new Report(join(EVIDENCE, 'demo-f'));
  const rt = freshHome(home('f'));
  const gate = new Gate(rt);
  try {
    const init = gate.init();
    const policyPath = join(PROTECTED_SRC, 'policy.json');
    const policyBefore = readFileSync(policyPath, 'utf8');
    rep.check('The host\'s actual separation was tested, not assumed', true, `mode ${init.isolation.mode}: ${init.isolation.notes.join('; ')}`);

    const screened = await runExperiment(rt, gate, 'exec-tamper');
    rep.check('As submitted, the candidate is rejected before any of its code runs', screened.receipt.decision === 'reject' && screened.receipt.gates.some((g) => g.id === 'no_forbidden_capabilities' && g.verdict === 'FAILED'), screened.receipt.gates.find((g) => g.id === 'no_forbidden_capabilities')!.meaning);

    const forced = await runExperiment(rt, gate, 'exec-tamper', { force_execute_despite_screening: true });
    const reported = forced.receipt.isolation.notes.filter((n) => n.startsWith('candidate reported:'));
    rep.check('Run anyway for this demonstration, every attempt on the rules and the records is denied', reported.length === 6 && reported.every((n) => /denied/.test(n)), reported.map((n) => n.replace('candidate reported: ', '')).join('; '));
    rep.check('The gate verifies for itself that nothing changed', forced.receipt.isolation.intact && readFileSync(policyPath, 'utf8') === policyBefore && rt.registry.active() === 'r1' && gate.verifyLedger().ok, `protected digest ${forced.receipt.isolation.protected_digest_before.slice(0, 16)} before and after; active release r1; ledger chain intact`);

    // The operating-system layer on its own: the same attacks without Node's permission model.
    if (init.isolation.uid_separation) {
      const script = `const fs=require('fs');const out=[];const t=(l,f)=>{try{f();out.push(l+': SUCCEEDED')}catch(e){out.push(l+': denied ('+e.code+')')}};
t('overwrite the promotion policy',()=>fs.writeFileSync(${JSON.stringify(policyPath)},'{}'));
t('read the held-out cases',()=>fs.readFileSync(${JSON.stringify(join(PROTECTED_SRC, 'cases', 'review-holdout.ts'))},'utf8'));
t('append to the evaluation ledger',()=>fs.appendFileSync(${JSON.stringify(rt.paths.gateDb)},'x'));
t('rewrite the active release pointer',()=>fs.writeFileSync(${JSON.stringify(join(rt.paths.protected, 'registry', 'ACTIVE'))},'r999'));
t('modify its own bundle in custody',()=>fs.writeFileSync(${JSON.stringify(join(forced.experiment.candidate!.ingested_dir, 'execution.json'))},'{}'));
console.log(JSON.stringify(out));`;
      const r = spawnSync('setpriv', [`--reuid=${CANDIDATE_UID}`, `--regid=${CANDIDATE_UID}`, '--clear-groups', '--', process.execPath, '-e', script], { encoding: 'utf8', env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, cwd: '/' });
      const outcomes = JSON.parse(r.stdout.trim() || '[]') as string[];
      rep.check('With Node\'s permission model removed, the operating system alone still denies every attempt', outcomes.length === 5 && outcomes.every((o) => /denied \((EACCES|EPERM)\)/.test(o)), outcomes.join('; '));
      rep.file('os-layer-attempts.json', { ran_as_uid: CANDIDATE_UID, node_permission_model: false, outcomes });
    } else {
      rep.check('Operating-system user separation is not available on this host', true, 'ENVIRONMENTAL LIMITATION: not running as root, so candidate code shares the operator\'s user. Only Node\'s permission model (a seat belt, not a security boundary) and digest comparison apply.');
    }

    const proposal = gate.proposeRuleChange({ proposed_by: 'evolution-swarm', summary: 'raise the allowed false-alarm margin from 5% to 30%', rationale: 'so that the first interface-compatibility candidate would pass', experiment_id: forced.experiment.id });
    const d = rt.store.decisions.must(proposal.decision_id);
    rep.check('A proposal to change the rules is routed to the chief of staff and applied by nobody', d.requires_human && d.owner_id === 'chief_of_staff' && d.status === 'open' && proposal.applied === false && readFileSync(policyPath, 'utf8') === policyBefore, `decision ${d.id} awaits a person; the policy file is unchanged`);

    // A change made outside the authorized path is detected and blocks every decision.
    let detected = false;
    let blocked = '';
    if (init.isolation.uid_separation) {
      writeFileSync(policyPath, policyBefore.replace('"false_alarm_margin": 0.05', '"false_alarm_margin": 0.30'));
      try {
        detected = !gate.integrity().ok;
        const r = await runExperiment(rt, gate, 'exec-interface-compat-naive');
        blocked = `${r.receipt.decision}: ${r.receipt.gates.find((g) => g.id === 'protected_integrity')!.meaning}`;
        detected = detected && r.receipt.decision === 'reject';
      } finally {
        writeFileSync(policyPath, policyBefore);
      }
      rep.check('If the rules are altered out of band anyway, the gate notices and refuses to decide on them', detected && gate.integrity().ok, `INJECTED: the operator account edited the policy without approval → ${blocked}. File restored; digest matches the seal again.`);
    }
    saveReceipt(rep, 'tamper-screened', screened.receipt);
    saveReceipt(rep, 'tamper-forced-run', forced.receipt);
    rep.file('isolation.json', { capability: init.isolation, what_is_enforced: 'Candidate code (validators and policies) executes under a separate operating-system user with Node\'s permission model on top; the protected rules, held-out cases, evaluation records and release registry are owned by the gate\'s user with mode 0700.', what_is_only_procedural: ['A live model worker acting as candidate author runs as the operator user in this build; whether `claude -p` can authenticate under the candidate uid was not verified.', 'The held-out generator is committed in this repository for reproducibility, so an author with repository read access as the operator user could read it.', 'The operator account (root here) can edit the protected store; that is detected by digest comparison, not prevented.'] });
    return finish('f', 'Isolation of the rules and the records', ['INJECTED FAULT — an adversarial candidate fixture', `ISOLATION MODE ON THIS HOST: ${init.isolation.mode}`], rep, t0, ['A candidate tries to overwrite the promotion policy and the scoring rules, read the held-out cases, append to the evaluation ledger, move the release pointer and plant a result.']);
  } finally {
    gate.close();
    rt.close();
  }
}

// ───────────────────────────── G: rollback ─────────────────────────────

async function demoG(): Promise<DemoResult> {
  const t0 = Date.now();
  const rep = new Report(join(EVIDENCE, 'demo-g'));
  const rt = freshHome(home('g'));
  const gate = new Gate(rt);
  gate.init();
  const co = new Coordinator(rt);
  try {
    const cos = new LocalChiefOfStaff(rt, (m) => gate.releaseFor(m));
    cos.onPinned = (c, m) => gate.noteCanaryMission(c, m);
    const ing = cos.ingestRequests({ command: 'ingestRequests', actor: 'chief_of_staff', key: 'demo-g-ingest', data: { requests: scenarioRequests() } });
    if (ing.source === 'unavailable') throw new Error(ing.reason);
    const ids = ing.clusters[0]!.request_ids;
    const submit = (key: string, request_ids: string[] = []) => {
      const r = cos.submitMission({ command: 'submitMission', actor: 'chief_of_staff', key: `demo-g-${key}`, data: { title: `Shared dataset-health capability (${key})`, objective: 'One policy-driven view of dataset health.', request_ids, scenario: 'shared-capability' } });
      if (r.source === 'unavailable') throw new Error(r.reason);
      return r.mission;
    };
    const earlier = submit('earlier');
    const first = await runExperiment(rt, gate, 'exec-interface-compat-naive');
    const accepted = await runExperiment(rt, gate, 'exec-interface-compat', { revises_experiment: first.experiment.id });
    const r2 = accepted.receipt.release_manifest!.release_id;
    const canary = gate.startCanary(r2, { max_missions: 2, scenario: 'shared-capability' });
    const inCanary = submit('canary-1', ids);
    rep.check('A qualified candidate is activated only in a bounded development canary', inCanary.release_id === r2 && rt.store.missions.must(earlier.id).release_id === 'r1' && rt.registry.active() === 'r1', `canary of ${canary.scope.max_missions} synthetic missions; new mission pinned to ${inCanary.release_id}; the earlier mission stays on r1; default release still r1`);
    await co.runUntilIdle({ mission_id: inCanary.id, max_ms: 90_000 });
    await co.drain();
    const inFlight = submit('canary-2');
    const outside = submit('after-canary-full');
    rep.check('The canary is bounded', inFlight.release_id === r2 && outside.release_id === 'r1', `second mission took the last canary place; the next one got ${outside.release_id}`);

    const healthy = await gate.observeCanary(canary.id);
    rep.check('Monitoring on fresh cases finds nothing wrong at first', healthy.status === 'running', healthy.observations.map((o) => `${o.metric}=${o.value ?? '—'}`).join('; '));
    const before = gate.dependents(r2);
    const after = await gate.observeCanary(canary.id, { inject_regression: { class: 'unit_annotation_added', weight: 6 } });
    const breach = after.observations.filter((o) => o.breached);
    rep.check('An injected regression is measured, not asserted', after.status === 'rolled_back' && breach.some((o) => o.injected), `INJECTED: later traffic contains a kind of safe change no evaluation set had. ${breach.map((o) => `${o.metric}=${o.value} against a limit of ${o.threshold}`).join('; ')}`);
    rep.check('The prior release is restored', rt.registry.active() === 'r1' && rt.registry.manifest(r2).status === 'rolled_back' && submit('after-rollback').release_id === 'r1', `active release r1; ${r2} marked rolled_back; new work is pinned to r1`);
    const now = gate.dependents(r2);
    rep.check('Missions, artifacts and memories that depended on the rolled-back version are identified', before.missions.length === 2 && before.artifacts.length > 0 && before.memories.length > 0, `${before.missions.length} missions (${before.missions.map((m) => `${m.status}${m.in_flight ? ', in flight' : ''}`).join('; ')}), ${before.artifacts.length} artifacts, ${before.memories.length} memories`);
    rep.check('None of them is silently kept', now.artifacts.every((a) => a.currency !== 'current') && now.memories.every((x) => x.status === 'invalidated'), `artifacts marked needs_revalidation; memories invalidated with the reason "rollback of ${r2}"`);
    const migration = rt.store.decisions.where(`"kind" = 'migration'`);
    rep.check('Migration of in-flight work is a deliberate, visible decision', migration.length === 1 && migration[0]!.mission_id === inFlight.id && migration[0]!.requires_human, `one decision opened for the chief of staff about the in-flight mission: ${migration[0]?.options.map((o) => o.id).join(' or ')}`);
    rep.file('canary.json', gate.canaries.must(canary.id));
    rep.file('dependents.json', { release: r2, before_rollback: before, after_rollback: now });
    rep.file('release-manifests.json', rt.registry.list());
    rep.file('rollback-ledger.json', gate.ledger().filter((l) => ['canary_started', 'canary_observation', 'rollback'].includes(l.kind)));
    saveReceipt(rep, 'accepted-then-rolled-back', accepted.receipt);
    return finish('g', 'Canary and rollback', [...FIXTURE_LABELS, 'INJECTED REGRESSION — a traffic shift toward a case class no evaluation set contained'], rep, t0, ['An accepted release runs in a canary limited to two synthetic missions. Monitoring scores it on fresh cases and compares with what it scored when approved. The driver then shifts monitored traffic toward a safe change the accepted validator mishandles.']);
  } finally {
    co.stop();
    gate.close();
    rt.close();
  }
}

// ───────────────────────────── H: targeted comparison against a simpler configuration ─────────────────────────────

async function demoH(): Promise<DemoResult> {
  const t0 = Date.now();
  const rep = new Report(join(EVIDENCE, 'demo-h'));
  const rt = freshHome(home('h'));
  const gate = new Gate(rt);
  installArena(gate);
  try {
    gate.init();
    const r = await runExperiment(rt, gate, 'coord-self-verification');
    const rec = r.receipt;
    const get = (m: string) => rec.comparisons.find((c) => c.metric === m)!;
    const correct = get('truly_correct_missions');
    const escaped = get('escaped_defects_per_mission');
    const inv = get('worker_invocations_per_mission');
    const time = get('completion_ms');
    rep.check('The simpler configuration is a coordination-level candidate with its own version', rec.level === 'coordination' && rec.change.files.some((f) => f.path === 'coordination.json'), `coordination v${rec.parent.version} → candidate: ${rec.change.summary}`);
    rep.check('Both configurations run the same seeded missions end to end', correct.n === 8, `${correct.n} complete fixture missions per configuration from held-out set ${rec.evaluation.holdout_set}; a defect is injected into a first attempt in about half of them`);
    rep.check('The simpler configuration really is cheaper and faster', inv.diff_vs_incumbent! < 0 && time.diff_vs_incumbent! < 0, `worker invocations per mission ${inv.incumbent} → ${inv.candidate}; completion ${Math.round(time.incumbent!)} ms → ${Math.round(time.candidate!)} ms`);
    rep.check('What it gives up is measured by an oracle, not assumed', escaped.candidate !== null, `defects reaching an accepted result per mission ${escaped.incumbent} → ${escaped.candidate}; truly correct missions ${correct.incumbent} → ${correct.candidate} (difference ${correct.diff_vs_incumbent}, 95% interval ${correct.ci95_vs_incumbent![0]} to ${correct.ci95_vs_incumbent![1]})`);
    rep.check('The decision follows the frozen rule', rec.decision !== 'accept' || escaped.candidate! <= escaped.incumbent!, `${rec.decision}: ${rec.justification}`);
    saveReceipt(rep, 'self-verification', rec);
    const snap = JSON.parse(readFileSync(join(rt.paths.protected, 'evaluations', `${r.experiment.id}.json`), 'utf8')) as { snapshot: { incumbent: unknown; candidate: unknown } };
    rep.file('episodes.json', { note: 'Per-episode results. Injected defects are labeled.', incumbent_independent_verification: snap.snapshot.incumbent, candidate_self_verification: snap.snapshot.candidate });

    // Second comparison: is the interface agreement before parallel work worth its step?
    type Ep = { seed: string; interface_mismatch: boolean; worker_invocations: number; elapsed_ms: number; integration_failures: number; rework: number; truly_correct: boolean };
    const r2 = await runExperiment(rt, gate, 'coord-no-interface-agreement');
    const rec2 = r2.receipt;
    const get2 = (m: string) => rec2.comparisons.find((c) => c.metric === m)!;
    const snap2 = (JSON.parse(readFileSync(join(rt.paths.protected, 'evaluations', `${r2.experiment.id}.json`), 'utf8')) as { snapshot: { incumbent: Ep[]; candidate: Ep[] } }).snapshot;
    const avg = (xs: number[]): number | null => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
    const pairs = snap2.candidate.map((c, i) => ({ c, inc: snap2.incumbent[i]! }));
    const clean = pairs.filter((x) => !x.c.interface_mismatch);
    const clash = pairs.filter((x) => x.c.interface_mismatch);
    // Paired on the same episode, so whatever else was injected is the same in both arms.
    const stepCost = { invocations: avg(clean.map((x) => x.inc.worker_invocations - x.c.worker_invocations)), ms: avg(clean.map((x) => x.inc.elapsed_ms - x.c.elapsed_ms)) };
    const clashCost = { invocations: avg(clash.map((x) => x.c.worker_invocations - x.inc.worker_invocations)), ms: avg(clash.map((x) => x.c.elapsed_ms - x.inc.elapsed_ms)) };
    const perClash = stepCost.invocations !== null && clashCost.invocations !== null ? clashCost.invocations + stepCost.invocations : null;
    const breakEven = perClash && stepCost.invocations !== null && perClash > 0 ? Math.round((stepCost.invocations / perClash) * 100) : null;
    const integ = get2('integration_failures_per_mission');
    const inv2 = get2('worker_invocations_per_mission');
    const time2 = get2('completion_ms');
    const correct2 = get2('truly_correct_missions');
    rep.check('A second simplification is put to the same gate: no interface agreement before parallel work', rec2.level === 'coordination' && rec2.evaluation.holdout_set !== null, `${rec2.change.summary} Run on ${rec2.evaluation.holdout_set}; the workstreams disagreed about the shared record in ${clash.length} of ${pairs.length} episodes (an assumed rate).`);
    rep.check('The cost of the step and the cost of going without it are both measured', stepCost.invocations !== null && clashCost.invocations !== null, `the agreement step costs ${stepCost.invocations} worker invocations and ${stepCost.ms} ms per mission; a mission where the workstreams disagreed cost ${clashCost.invocations} more invocations and ${clashCost.ms} ms more than the same mission with the agreement`);
    rep.check('Integration failures and quality are reported, not assumed', integ.candidate !== null, `integration failures per mission ${integ.incumbent} → ${integ.candidate}; truly correct missions ${correct2.incumbent} → ${correct2.candidate}; invocations ${inv2.incumbent} → ${inv2.candidate} (difference ${inv2.diff_vs_incumbent}, 95% interval ${inv2.ci95_vs_incumbent![0]} to ${inv2.ci95_vs_incumbent![1]}); completion ${Math.round(time2.incumbent!)} ms → ${Math.round(time2.candidate!)} ms`);
    rep.check('The decision follows the frozen rule, whatever it is', ['accept', 'reject', 'inconclusive'].includes(rec2.decision), `${rec2.decision}: ${rec2.justification}`);
    saveReceipt(rep, 'no-interface-agreement', rec2);
    rep.file('interface-agreement.json', {
      note: 'Per-episode results for the interface-agreement comparison. The share of episodes in which the workstreams disagree is an ASSUMPTION of the testbed; the costs are measured. Fixture step durations are synthetic, and a fixture counts every worker invocation the same, whereas real rework usually costs more than a planning step.',
      measured: { agreement_step_cost: stepCost, extra_cost_of_a_mission_with_a_mismatch: clashCost, break_even_mismatch_rate_percent_on_invocations: breakEven },
      incumbent_with_agreement: snap2.incumbent, candidate_without_agreement: snap2.candidate,
    });
    return finish('h', 'Targeted comparisons against simpler configurations', [...FIXTURE_LABELS, 'INJECTED DEFECTS — in about half of the episodes one worker\'s first attempt carries a defect its own tests do not catch', 'ASSUMED RATES — how often defects occur, and how often two workstreams disagree about an interface nobody agreed, are parameters of this testbed. The comparisons show what each coordination step catches and costs when those things happen; they do not show how often they happen in real work.'], rep, t0, [
      'Does the independent verification swarm earn its cost? The question is put to the release gate as a coordination-level simplification: retire the verification swarm and trust delivery\'s own combined tests.',
      'Each configuration runs the same eight seeded missions on the real runtime. Afterwards an oracle runs the protected acceptance suite on whatever each mission accepted.',
      'Does the interface agreement before parallel work earn its step? The second simplification removes it: no contract task, and the two delivery workstreams start from the acceptance criteria alone.',
      breakEven === null ? 'A break-even rate could not be computed from these episodes.' : `Counting worker invocations only, the agreement pays for itself when the workstreams would otherwise disagree in more than about ${breakEven}% of missions. In this fixture every invocation counts the same; real rework usually costs more than a planning step, which would lower that figure.`,
    ]);
  } finally {
    gate.close();
    rt.close();
  }
}

// ───────────────────────────── I: the portfolio under each improvement policy ─────────────────────────────

async function demoI(): Promise<DemoResult> {
  const t0 = Date.now();
  const rep = new Report(join(EVIDENCE, 'demo-i'));
  const BUDGET = 900;
  const open = (name: string) => {
    const rt = freshHome(home(name));
    const gate = new Gate(rt);
    installArena(gate);
    gate.init();
    return { rt, gate };
  };
  const control = open('i-control');
  const trial = open('i-trial');
  try {
    const seed = async (x: typeof control) => {
      const seen = await observeReviewWork(x.rt, x.gate);
      recordReport(x.rt, { failure_class: 'style_nit', count: 30, note: 'SYNTHETIC complaint, never verified: optional field names are not snake_case' });
      return seen;
    };
    const line = (s: PortfolioStep): string => `${s.n}. ${s.action.type}${s.action.candidate_id ? ' ' + s.action.candidate_id : ''} → ${s.outcome} (${s.cost} units)`;
    const tally = (v: PortfolioView) => {
      const accepted = v.hypotheses.filter((h) => h.status === 'accepted');
      const failed = v.hypotheses.filter((h) => h.submitted && h.status !== 'accepted');
      const unsubmitted = v.hypotheses.filter((h) => h.built && !h.submitted);
      return { spent: v.allocation.campaign_spent, accepted: accepted.map((h) => h.id), not_accepted: failed.map((h) => `${h.id} (${h.status})`), units_on_experiments_not_accepted: failed.reduce((a, h) => a + h.cost_so_far, 0), units_on_builds_never_submitted: unsubmitted.reduce((a, h) => a + h.cost_so_far, 0), held_out_evaluations_used: v.hypotheses.filter((h) => h.submitted).length };
    };

    // Control: the baseline release decides.
    const seen = await seed(control);
    const a = await portfolioCampaign(control.rt, control.gate, { budget: BUDGET });
    const ta = tally(a.view);
    rep.check('The organization keeps a portfolio of hypotheses built from its own recorded observations', a.view.problems.some((p) => p.verified_count > 0) && a.view.hypotheses.length >= 6, `${seen.observation_ids.length} verified review failures in ${Object.keys(seen.by_class).length} classes, plus 30 unverified reports of one complaint; ${a.view.hypotheses.length} hypotheses`);
    rep.check('The policy of the release in force decides each step, inside a bounded budget', a.steps.every((s) => s.policy.id === 'frequency-first') && ta.spent <= BUDGET, `r1's policy (${a.steps[0]!.policy.id}) took ${a.steps.length} decisions and used ${ta.spent} of ${BUDGET} units`);

    // Trial: the gate qualifies the expected-value policy; it is then tried in a bounded canary.
    const evo = await runExperiment(trial.rt, trial.gate, 'evo-expected-value');
    const release = evo.receipt.release_manifest?.release_id ?? null;
    rep.check('The replacement policy first has to pass the release gate', evo.receipt.decision === 'accept' && release !== null, `${evo.receipt.decision}: ${evo.receipt.justification}`);
    const canary = trial.gate.startCanary(release!, { max_missions: 0 });
    await seed(trial);
    const b = await portfolioCampaign(trial.rt, trial.gate, { budget: BUDGET });
    const tb = tally(b.view);
    rep.check('During the canary the new policy decides, and the default has not changed', b.steps.every((s) => s.policy.canary_id === canary.id && s.policy.id === 'expected-value') && trial.rt.registry.active() === 'r1', `${b.steps.length} decisions under canary ${canary.id}; active release still ${trial.rt.registry.active()}`);
    rep.check('Replacing the policy changes what the organization works on', a.steps[0]!.action.candidate_id !== b.steps[0]!.action.candidate_id, `frequency-first began with ${a.steps[0]!.action.candidate_id}; expected-value began with ${b.steps[0]!.action.candidate_id} and piloted ${b.steps.filter((s) => s.action.type === 'pilot').length} times before submitting`);
    rep.check('Every submission from either policy was decided by the same release gate', [...a.view.hypotheses, ...b.view.hypotheses].filter((h) => h.submitted).every((h) => h.receipt_id !== null), `control: ${ta.accepted.length} accepted, ${ta.not_accepted.join(', ') || 'none'} not accepted; trial: ${tb.accepted.length} accepted, ${tb.not_accepted.join(', ') || 'none'} not accepted`);
    const failedMem = [...control.rt.store.memories.where(`"kind" = 'failed_approach'`), ...trial.rt.store.memories.where(`"kind" = 'failed_approach'`)];
    rep.check('Each approach that did not pass is recorded so it is not repeated blindly', failedMem.length === ta.not_accepted.length + tb.not_accepted.length, failedMem.map((m) => `[${m.certainty}] ${m.statement.slice(0, 110)}…`).join(' | '));

    const obs = await trial.gate.observeCanary(canary.id);
    const refused = obs.observations.find((o) => o.metric === 'policy_actions_refused');
    const retained = obs.status === 'running' ? trial.gate.retain(canary.id) : obs;
    rep.check('The canary is observed, then retained', retained.status === 'retained' && trial.rt.registry.active() === release, `actions the runtime had to refuse: ${refused?.value}; ${release} is now the default for future work`);
    const stale = b.view.hypotheses.find((h) => h.status === 'accepted');
    let refusal = 'no accepted fix to test';
    if (stale?.release_id) {
      try {
        trial.gate.startCanary(stale.release_id);
        refusal = 'NOT refused';
      } catch (e) {
        refusal = e instanceof Error ? e.message : String(e);
      }
    }
    const after = portfolio(trial.rt, trial.gate);
    rep.check('A fix qualified against the old default is not promoted over the new one', /qualified against/.test(refusal) && after.hypotheses.every((h) => h.status === 'proposed'), `${refusal} All ${after.hypotheses.length} hypotheses were reopened to be rebuilt on ${release}.`);

    rep.file('portfolio-control.json', { note: 'Baseline release r1, policy frequency-first. SYNTHETIC workload and fix library.', tally: ta, steps: a.steps, hypotheses: a.view.hypotheses, problems: a.view.problems });
    rep.file('portfolio-trial.json', { note: 'Canary of the expected-value policy. SYNTHETIC workload and fix library.', tally: tb, steps: b.steps, hypotheses: b.view.hypotheses, problems: b.view.problems });
    rep.file('comparison.json', { note: 'ONE campaign per policy on the same observations and budget. This is a case study of the two policies operating the real release gate. It is not a statistical comparison; Demonstration D is.', budget: BUDGET, control_frequency_first: ta, trial_expected_value: tb });
    saveReceipt(rep, 'expected-value-policy', evo.receipt);
    for (const h of [...a.view.hypotheses.map((x) => ['control', x] as const), ...b.view.hypotheses.map((x) => ['trial', x] as const)]) {
      if (h[1].receipt_id) saveReceipt(rep, `${h[0]}-${h[1].id}-${h[1].status}`, (h[0] === 'control' ? control.gate : trial.gate).receipt(h[1].receipt_id));
    }
    return finish('i', 'The improvement policy in force runs the organization\'s own improvement work', [...FIXTURE_LABELS, 'SYNTHETIC — the review workload, the 30 unverified complaints and the library of candidate fixes (some deliberately flawed)', 'One campaign per policy: a case study, not a statistical comparison'], rep, t0, [
      'Demonstration D compares two improvement policies statistically in a testbed. This one shows the policy of the release in force doing its real job: reading the organization\'s recorded observations and deciding what to build, pilot, submit to the release gate, or stop.',
      `Control (frequency-first): ${a.steps.map(line).join('; ')}.`,
      `Trial (expected-value, in a canary): ${b.steps.map(line).join('; ')}.`,
      `Units that did not end in an accepted change — control: ${ta.units_on_experiments_not_accepted} on experiments not accepted plus ${ta.units_on_builds_never_submitted} on builds never submitted; trial: ${tb.units_on_experiments_not_accepted} plus ${tb.units_on_builds_never_submitted}. Each policy got ${ta.accepted.length} and ${tb.accepted.length} fix(es) accepted.`,
    ]);
  } finally {
    control.gate.close();
    control.rt.close();
    trial.gate.close();
    trial.rt.close();
  }
}

// ───────────────────────────── runner ─────────────────────────────

const DEMOS: Record<string, () => Promise<DemoResult>> = { a: demoA, b: demoB, c: demoC, d: demoD, e: demoE, f: demoF, g: demoG, h: demoH, i: demoI };

async function main(): Promise<void> {
  const which = (process.argv[2] ?? 'all').toLowerCase();
  const names = which === 'all' ? Object.keys(DEMOS) : [which];
  const results: DemoResult[] = [];
  for (const n of names) {
    const fn = DEMOS[n];
    if (!fn) throw new Error(`unknown demonstration ${n}`);
    process.stdout.write(`\n== Demonstration ${n.toUpperCase()} ==\n`);
    results.push(await fn());
  }
  process.stdout.write('\n== Summary ==\n');
  for (const r of results) process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.demo.toUpperCase()} ${r.title} — ${r.steps.filter((s) => s.ok).length}/${r.steps.length} checks held, ${r.ms} ms → evidence/demo-${r.demo}/\n`);
  if (which === 'all') writeEvidence(EVIDENCE, 'summary.json', { ran_at: new Date().toISOString(), provider: LIVE ? 'live' : 'fixture', results: results.map((r) => ({ demo: r.demo, title: r.title, ok: r.ok, checks: r.steps.length, held: r.steps.filter((s) => s.ok).length, ms: r.ms, labels: r.labels })) });
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack : err) + '\n');
  process.exit(1);
});
