import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../config.ts';
import type { ExecutionDef } from '../contracts/definitions.ts';
import type { Iso, Memory, ReleaseManifest } from '../contracts/types.ts';
import type { Gate } from '../gate/gate.ts';
import { CandidateProcess } from '../gate/sandbox.ts';
import { SwarmError, newId } from '../lib/util.ts';
import { reconsider } from '../memory/memory.ts';
import type { Runtime } from '../runtime.ts';
import { type LabeledCase, devCases } from '../../fixtures/evolution/review-cases.ts';
import { type Fix, fixLibrary } from './arena.ts';
import { type CandidateSpec, buildCandidate } from './candidates.ts';
import { runExperiment } from './loop.ts';

/**
 * THE HYPOTHESIS PORTFOLIO — the organization's own improvement work, decided by the active
 * improvement policy.
 *
 * The improvement arena compares policies in a synthetic testbed. This module is where the policy
 * of the release that is actually in force does its job: it reads the organization's recorded
 * observations and the state of every hypothesis, and decides the next step — build a candidate,
 * pilot it on observed cases, submit it to the release gate, or stop. Replacing the evolution
 * component of a release therefore changes what the organization works on next.
 *
 * What is real: the observations, the policy code (run in the candidate sandbox), the release
 * gate and its held-out cases, the receipts and releases.
 * What is synthetic: the review workload, and the fix library that stands in for a model author
 * writing candidate fixes. A build cost is a declared fixture value, not a measurement.
 */

const COMPONENT = 'execution:change-review';
const LIB_DIR = join(REPO_ROOT, 'fixtures', 'evolution', 'fix-library');

export interface Hypothesis {
  id: string;
  problem_ids: string[];
  statement: string;
  status: 'proposed' | 'built' | 'piloted' | 'dropped' | 'accepted' | 'rejected' | 'inconclusive';
  /** The release the candidate was built on. A change of active release sends unfinished work back to proposed. */
  parent_release: string | null;
  build_cost: number;
  built: boolean;
  pilot: { cases: number; attempted: number; fixed: number; broke: number } | null;
  submitted: boolean;
  result: string | null;
  experiment_id: string | null;
  receipt_id: string | null;
  release_id: string | null;
  failed_approach_memory_id: string | null;
  cost_so_far: number;
}

export interface PortfolioStep {
  n: number;
  at: Iso;
  policy: { release_id: string; evolution_version: number; id: string; canary_id: string | null };
  action: { type: string; candidate_id?: string; cases?: number; reason?: string };
  outcome: string;
  cost: number;
  experiment_id: string | null;
  receipt_id: string | null;
}

export interface PortfolioDoc {
  hypotheses: Hypothesis[];
  steps: PortfolioStep[];
  /** Units this portfolio has used: declared build costs, pilot cases and gate evaluations. */
  spent: number;
  invalid_actions: number;
}

export interface Problem {
  id: string;
  /** Checked failures under the active release. */
  verified_count: number;
  /** Every report, checked or not. */
  observed_count: number;
  severity: number;
  resolved: boolean;
}

export const PORTFOLIO_KEY = 'evolution:portfolio';
const KEY = PORTFOLIO_KEY;

/**
 * Which release's improvement policy is in charge. Normally the active release. While a canary is
 * running for a release that changes the improvement policy, that policy decides — this is how an
 * improvement-policy release is tried on bounded work before it becomes the default.
 */
export function governingRelease(rt: Runtime, gate: Gate): { manifest: ReleaseManifest; canary_id: string | null } {
  const active = rt.registry.manifest(rt.registry.active());
  const canary = gate.canaries.first(`"status" = 'running'`);
  if (canary) {
    const m = rt.registry.manifest(canary.release_id);
    if (m.components.evolution.version !== active.components.evolution.version) return { manifest: m, canary_id: canary.id };
  }
  return { manifest: active, canary_id: null };
}
const BATCHES = 'evolution:observed_batches';

export interface ObservedBatch {
  seed: string;
  n: number;
  release_id: string;
}

/** Remember which development cases produced the recorded observations, so pilots can use the same cases. */
export function noteObservedBatch(rt: Runtime, b: ObservedBatch): void {
  const all = rt.store.getMeta<ObservedBatch[]>(BATCHES) ?? [];
  if (!all.some((x) => x.seed === b.seed && x.n === b.n && x.release_id === b.release_id)) rt.store.setMeta(BATCHES, [...all, b]);
}

function load(rt: Runtime): PortfolioDoc {
  return rt.store.getMeta<PortfolioDoc>(KEY) ?? { hypotheses: [], steps: [], spent: 0, invalid_actions: 0 };
}

/**
 * Record a report nobody has verified (for example a complaint). It counts as an observation
 * and never as a verified failure.
 */
export function recordReport(rt: Runtime, input: { failure_class: string; count: number; note: string; source?: 'fixture' | 'live' }): string[] {
  const ids: string[] = [];
  for (let i = 0; i < input.count; i++) {
    ids.push(rt.kernel.observe({ mission_id: null, task_id: null, kind: 'repeated_mistake', failure_class: input.failure_class, certainty: 'suspected', details: { note: input.note, reported: true }, component: COMPONENT, release_id: rt.registry.active(), source: input.source ?? 'fixture' }).id);
  }
  rt.store.emit({ type: 'reports_recorded', actor_id: 'operator', actor_kind: 'operator', payload: { failure_class: input.failure_class, count: input.count, certainty: 'suspected', note: input.note } });
  return ids;
}

/** Open problems, from recorded observations. Verified failures count only under the release now in force. */
export function problems(rt: Runtime, doc: PortfolioDoc = load(rt)): Problem[] {
  const active = rt.registry.active();
  const obs = rt.store.observations.where('"component" = ?', COMPONENT);
  const classes = [...new Set(obs.filter((o) => o.certainty === 'suspected' || o.release_id === active).map((o) => o.failure_class))].sort();
  return classes.map((id) => {
    const verified = obs.filter((o) => o.failure_class === id && o.certainty === 'verified' && o.release_id === active);
    const reports = obs.filter((o) => o.failure_class === id && o.certainty === 'suspected');
    const sev = verified.map((o) => Number(o.details.severity ?? 1));
    // A fix the gate accepted is waiting on its canary: the problem is not open for more work meanwhile.
    const pending = doc.hypotheses.some((h) => h.status === 'accepted' && h.problem_ids.includes(id) && h.release_id !== null && rt.registry.manifest(h.release_id).status === 'canary');
    return { id, verified_count: verified.length, observed_count: verified.length + reports.length, severity: sev.length ? sev.reduce((a, b) => a + b, 0) / sev.length : 0, resolved: pending };
  });
}

/** Bring the portfolio in line with the library and with the release now in force. */
function reconcile(rt: Runtime, doc: PortfolioDoc): PortfolioDoc {
  const active = rt.registry.active();
  const byId = new Map(doc.hypotheses.map((h) => [h.id, h]));
  const next: Hypothesis[] = [];
  for (const f of fixLibrary()) {
    let h = byId.get(f.id);
    if (!h) {
      h = { id: f.id, problem_ids: f.problem_ids, statement: `If change review also runs ${f.id}, verified failures of ${f.problem_ids.join(', ')} will be blocked without blocking safe changes.`, status: 'proposed', parent_release: null, build_cost: f.build_cost, built: false, pilot: null, submitted: false, result: null, experiment_id: null, receipt_id: null, release_id: null, failed_approach_memory_id: null, cost_so_far: 0 };
    } else if (h.status === 'accepted' && h.release_id !== null && rt.registry.manifest(h.release_id).status === 'canary' && rt.registry.manifest(h.release_id).parent_release_id !== active) {
      // Accepted, but against a release that is no longer the default: the gate will not promote
      // it over the new default, so the hypothesis goes back to be rebuilt and evaluated again.
      rt.store.emit({ type: 'hypothesis_reopened', actor_id: 'evolution-swarm', actor_kind: 'agent', payload: { hypothesis: h.id, was: 'accepted', release_id: h.release_id, qualified_against: h.parent_release, active, why: 'qualified against a release that is no longer active' } });
      h = { ...h, status: 'proposed', parent_release: null, built: false, pilot: null, submitted: false, result: null, release_id: null };
    } else if (h.parent_release !== null && h.parent_release !== active && h.status !== 'accepted') {
      // The environment changed. Unfinished work must be rebuilt on the new release, and an approach
      // that failed against the old one is worth another look — as a suspicion, not as settled.
      if (h.failed_approach_memory_id) reconsider(rt, h.failed_approach_memory_id, `the active release changed from ${h.parent_release} to ${active}`);
      rt.store.emit({ type: 'hypothesis_reopened', actor_id: 'evolution-swarm', actor_kind: 'agent', payload: { hypothesis: h.id, was: h.status, built_on: h.parent_release, active } });
      h = { ...h, status: 'proposed', parent_release: null, built: false, pilot: null, submitted: false, result: null };
    }
    next.push(h);
  }
  return { ...doc, hypotheses: next };
}

function specDir(rt: Runtime, fix: Fix): string {
  return join(rt.paths.candidates, 'portfolio', fix.id, 'spec');
}

/** Write the candidate the hypothesis describes: the parent skill with one more check. */
function writeSpec(rt: Runtime, fix: Fix, h: Hypothesis, parentDir: string, open: Problem[]): string {
  const dir = specDir(rt, fix);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'files', 'validators'), { recursive: true });
  cpSync(join(LIB_DIR, fix.file), join(dir, 'files', 'validators', fix.file));
  const skill = (JSON.parse(readFileSync(join(parentDir, 'execution.json'), 'utf8')) as ExecutionDef).skills['change-review']!;
  const seen = open.filter((p) => fix.problem_ids.includes(p.id)).map((p) => `${p.id} (${p.verified_count} verified, ${p.observed_count - p.verified_count} unverified reports)`);
  const spec: CandidateSpec = {
    candidate_id: `portfolio-${fix.id}`,
    level: 'execution',
    title: `Add the ${fix.id} check to change review`,
    problem: `Review failures recorded under ${rt.registry.active()}: ${seen.join('; ') || 'none verified'}.`,
    failure_classes: fix.problem_ids,
    hypothesis: h.statement,
    expected_benefit: 'Fewer approved breaking changes of these classes.',
    possible_regressions: ['Safe changes could be blocked', 'Each review runs one more step'],
    change_summary: `Adds the ${fix.id} check to the change-review skill.`,
    revises: null,
    declared_simplification: false,
    skill_patch: { skill_id: 'change-review', validators_add: [fix.file], validators_remove: [], procedure: [...skill.procedure.slice(0, -1), `Run the ${fix.id} check and block on its findings`, ...skill.procedure.slice(-1)], known_failure_cases: skill.known_failure_cases },
  };
  writeFileSync(join(dir, 'candidate.json'), JSON.stringify(spec, null, 2) + '\n');
  return dir;
}

function submitCostEstimate(gate: Gate): number {
  // Three arms (candidate, incumbent, baseline) over the held-out cases, plus the author's development check.
  return 3 * gate.policy().levels.execution.holdout_cases + 41;
}

export interface PortfolioView {
  source: 'fixture';
  policy: { release_id: string; evolution_version: number; id: string | null; canary_id: string | null; summary: string; prioritization: string; stopping: string };
  allocation: { campaign_spent: number; exploration: { budget: number; spent: number; remaining: number } };
  problems: Problem[];
  hypotheses: Hypothesis[];
  steps: PortfolioStep[];
  limitation: string;
}

/** The portfolio as a read model. */
export function portfolio(rt: Runtime, gate: Gate): PortfolioView {
  const doc = reconcile(rt, load(rt));
  const { manifest: m, canary_id } = governingRelease(rt, gate);
  const def = JSON.parse(readFileSync(join(rt.registry.componentDir('evolution', m.components.evolution.version), 'evolution.json'), 'utf8')) as { summary: string; prioritization: string; stopping: string };
  return {
    source: 'fixture',
    policy: { release_id: m.release_id, evolution_version: m.components.evolution.version, id: doc.steps.filter((x) => x.policy.release_id === m.release_id).at(-1)?.policy.id ?? null, canary_id, summary: def.summary, prioritization: def.prioritization, stopping: def.stopping },
    allocation: { campaign_spent: doc.spent, exploration: gate.exploration() },
    problems: problems(rt, doc),
    hypotheses: doc.hypotheses,
    steps: doc.steps,
    limitation: 'The review workload is synthetic and the candidate fixes come from a pre-authored library that stands in for a model author. Build costs are declared fixture values.',
  };
}

/** Observed cases for a pilot: failures the fix targets, and cases the current skill already handles. */
async function pilotCases(rt: Runtime, gate: Gate, activeDir: string, fix: Fix, k: number): Promise<{ targets: LabeledCase[]; working: LabeledCase[] }> {
  const active = rt.registry.active();
  const batches = (rt.store.getMeta<ObservedBatch[]>(BATCHES) ?? []).filter((b) => b.release_id === active);
  const cases = batches.flatMap((b) => devCases(b.seed, b.n));
  if (cases.length === 0) return { targets: [], working: [] };
  const scores = (await gate.scoreBundle(activeDir, 'change-review', cases)).scores;
  const targets = cases.filter((c, i) => !scores[i]!.correct && fix.problem_ids.includes(c.label.defect_class)).slice(0, Math.ceil(k / 2));
  const working = cases.filter((_, i) => scores[i]!.correct).slice(0, k - targets.length);
  return { targets, working };
}

/**
 * One step of the organization's improvement work. The active release's improvement policy is
 * asked what to do; the runtime carries out exactly that step and records it.
 */
export async function portfolioStep(rt: Runtime, gate: Gate, opts: { budget: number }): Promise<{ step: PortfolioStep; ended: boolean }> {
  let doc = reconcile(rt, load(rt));
  // Candidates are always built on the active release; the policy in charge may be a canary's.
  const manifest = rt.registry.manifest(rt.registry.active());
  const governing = governingRelease(rt, gate);
  const evoVersion = governing.manifest.components.evolution.version;
  const evoDir = gate.stageForSandbox(rt.registry.componentDir('evolution', evoVersion));
  const module = (JSON.parse(readFileSync(join(evoDir, 'evolution.json'), 'utf8')) as { policy_module: string }).policy_module;
  const activeExecDir = rt.registry.componentDir('execution', manifest.components.execution.version);
  const open = problems(rt, doc);
  const remaining = Math.max(0, Math.min(opts.budget - doc.spent, gate.exploration().remaining));
  const state = {
    step: doc.steps.length + 1,
    budget_remaining: remaining,
    costs: { pilot_per_case: 1, submit: submitCostEstimate(gate) },
    problems: open,
    candidates: doc.hypotheses.map((h) => ({ id: h.id, problem_ids: h.problem_ids, build_cost: h.build_cost, built: h.built, pilot: h.pilot, submitted: h.submitted, result: h.result })),
  };

  // The policy is candidate-authored code: it runs in the sandbox and only returns a decision.
  const proc = new CandidateProcess(evoDir, { iso: gate.iso });
  let action: { type?: string; candidate_id?: string; cases?: number; reason?: string };
  let policyId = 'unknown';
  try {
    const loaded = await proc.request('load_policy', { bundle_dir: evoDir, module });
    if (!loaded.ok) throw new SwarmError('policy_not_loadable', `The active improvement policy could not be loaded: ${String(loaded.error)}`);
    policyId = String(loaded.policy ?? 'unknown');
    const res = await proc.request('decide', { state }, 5_000);
    if (!res.ok) throw new SwarmError('policy_failed', `The active improvement policy failed to decide: ${String(res.error)}`);
    action = res.action as typeof action;
  } finally {
    proc.close();
  }

  const fixes = fixLibrary();
  const fix = fixes.find((f) => f.id === action.candidate_id);
  const h = doc.hypotheses.find((x) => x.id === action.candidate_id);
  let outcome = '';
  let cost = 0;
  let ended = false;
  let experiment_id: string | null = null;
  let receipt_id: string | null = null;
  const update = (patch: Partial<Hypothesis>): void => {
    doc = { ...doc, hypotheses: doc.hypotheses.map((x) => (x.id === h!.id ? { ...x, ...patch } : x)) };
  };
  const refuse = (why: string): void => {
    outcome = `refused: ${why}`;
    doc = { ...doc, invalid_actions: doc.invalid_actions + 1 };
    if (doc.invalid_actions >= 3) ended = true;
  };

  if (action.type === 'stop') {
    outcome = `stopped: ${action.reason ?? 'the policy gave no reason'}`;
    ended = true;
  } else if (!fix || !h) {
    refuse(`there is no hypothesis ${String(action.candidate_id)}`);
  } else if (action.type === 'build') {
    if (h.built) refuse('already built');
    else if (h.build_cost > remaining) refuse('not enough budget to build');
    else {
      writeSpec(rt, fix, h, activeExecDir, open);
      cost = h.build_cost;
      update({ built: true, status: 'built', parent_release: manifest.release_id, cost_so_far: h.cost_so_far + cost });
      outcome = `built on ${manifest.release_id}`;
    }
  } else if (action.type === 'pilot') {
    const k = Math.max(2, Math.min(24, Math.floor(Number(action.cases ?? 8))));
    if (!h.built || h.submitted) refuse('a pilot needs a built candidate that has not been submitted');
    else if (k > remaining) refuse('not enough budget to pilot');
    else {
      const { targets, working } = await pilotCases(rt, gate, activeExecDir, fix, k);
      const cases = [...targets, ...working];
      if (cases.length === 0) refuse('there are no observed cases under the active release to pilot on');
      else {
        const built = buildCandidate(activeExecDir, specDir(rt, fix), join(rt.paths.candidates, 'portfolio', fix.id, 'pilot'), {});
        const before = (await gate.scoreBundle(activeExecDir, 'change-review', cases)).scores;
        const after = (await gate.scoreBundle(built.dir, 'change-review', cases)).scores;
        const pilot = { cases: cases.length, attempted: targets.length, fixed: targets.filter((_, i) => !before[i]!.correct && after[i]!.correct).length, broke: cases.filter((_, i) => before[i]!.correct && !after[i]!.correct).length };
        cost = cases.length;
        update({ pilot, status: 'piloted', cost_so_far: h.cost_so_far + cost });
        outcome = `pilot on ${pilot.cases} observed cases: fixed ${pilot.fixed} of ${pilot.attempted} targeted failures, broke ${pilot.broke} working cases`;
      }
    }
  } else if (action.type === 'submit') {
    if (!h.built || h.submitted) refuse('only a built candidate that has not been submitted can be submitted');
    else if (state.costs.submit > remaining) refuse('not enough budget for a held-out evaluation');
    else {
      const r = await runExperiment(rt, gate, fix.id, { spec_dir: specDir(rt, fix) });
      cost = r.receipt.resource_use.experiment_units;
      experiment_id = r.experiment.id;
      receipt_id = r.receipt.receipt_id;
      let memId: string | null = null;
      if (r.receipt.decision !== 'accept') {
        // A failed approach is recorded with enough context to avoid repeating it.
        const mem: Memory = {
          id: newId('mem'), kind: 'failed_approach',
          statement: `Adding the ${fix.id} check to change review (built on ${manifest.release_id}) was ${r.receipt.decision === 'reject' ? 'rejected' : 'inconclusive'} at the release gate: ${r.receipt.justification}`,
          scope: ['component:' + COMPONENT, ...fix.problem_ids.map((c) => `failure:${c}`)],
          provenance: { mission_id: null, task_id: null, evidence_ids: [r.receipt.receipt_id], artifact_version_ids: [], release_id: manifest.release_id, recorded_by: 'evolution-swarm' },
          origin: 'runtime', certainty: r.receipt.decision === 'reject' ? 'verified' : 'suspected', status: 'active', fresh_until: null, invalidated_by: null, superseded_by: null, validated_cases: 0, evidence_class: 'synthetic', created_at: rt.store.clock.iso(),
        };
        rt.store.memories.put(mem);
        memId = mem.id;
      }
      const status = r.receipt.decision === 'accept' ? 'accepted' : r.receipt.decision === 'reject' ? 'rejected' : 'inconclusive';
      update({ submitted: true, result: r.receipt.decision, status, experiment_id, receipt_id, release_id: r.receipt.release_manifest?.release_id ?? null, failed_approach_memory_id: memId, cost_so_far: h.cost_so_far + cost });
      outcome = `${r.receipt.decision} on ${r.receipt.evaluation.holdout_set ?? 'no held-out set'}${r.receipt.release_manifest ? `; ${r.receipt.release_manifest.release_id} is qualified for a canary` : ''}`;
    }
  } else {
    refuse(`unknown action ${String(action.type)}`);
  }

  // A built candidate the policy will not take further is recorded as dropped once the campaign stops.
  if (ended) doc = { ...doc, hypotheses: doc.hypotheses.map((x) => (x.built && !x.submitted && x.pilot && (x.pilot.broke > 0 || x.pilot.fixed === 0) ? { ...x, status: 'dropped' } : x)) };
  const step: PortfolioStep = { n: doc.steps.length + 1, at: rt.store.clock.iso(), policy: { release_id: governing.manifest.release_id, evolution_version: evoVersion, id: policyId, canary_id: governing.canary_id }, action: { type: String(action.type), candidate_id: action.candidate_id, cases: action.cases, reason: action.reason }, outcome, cost, experiment_id, receipt_id };
  doc = { ...doc, steps: [...doc.steps, step], spent: doc.spent + cost };
  rt.store.setMeta(KEY, doc);
  rt.store.emit({ type: 'portfolio_step', actor_id: 'evolution-swarm', actor_kind: 'agent', payload: { ...step, budget_remaining: Math.max(0, remaining - cost) }, release_id: manifest.release_id });
  if (!ended && Math.min(opts.budget - doc.spent, gate.exploration().remaining) <= 0) ended = true;
  return { step, ended };
}

/** Run the portfolio until the policy stops, the budget is spent, or a step limit is reached. */
export async function portfolioCampaign(rt: Runtime, gate: Gate, opts: { budget: number; max_steps?: number }): Promise<{ steps: PortfolioStep[]; ended: 'stop' | 'budget' | 'max_steps' | 'refused'; view: PortfolioView }> {
  const steps: PortfolioStep[] = [];
  let ended: 'stop' | 'budget' | 'max_steps' | 'refused' = 'max_steps';
  for (let i = 0; i < (opts.max_steps ?? 40); i++) {
    const r = await portfolioStep(rt, gate, opts);
    steps.push(r.step);
    if (r.ended) {
      ended = r.step.action.type === 'stop' ? 'stop' : r.step.outcome.startsWith('refused') ? 'refused' : 'budget';
      break;
    }
  }
  return { steps, ended, view: portfolio(rt, gate) };
}

export function portfolioExists(rt: Runtime): boolean {
  return existsSync(rt.paths.db) && rt.store.getMeta<PortfolioDoc>(KEY) !== null && rt.store.getMeta<PortfolioDoc>(KEY) !== undefined;
}
