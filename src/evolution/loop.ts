import { join } from 'node:path';
import { REPO_ROOT } from '../config.ts';
import type { ImprovementReceipt } from '../contracts/types.ts';
import { type Experiment, Gate } from '../gate/gate.ts';
import type { Runtime } from '../runtime.ts';
import { devCases } from '../../fixtures/evolution/review-cases.ts';
import { type BuiltCandidate, type CandidateSpec, buildCandidate } from './candidates.ts';
import { runPolicy } from './arena.ts';
import { noteObservedBatch } from './portfolio.ts';

export const CANDIDATE_LIBRARY = join(REPO_ROOT, 'fixtures', 'evolution', 'candidates');

/**
 * Step 1 of the lifecycle — observe. Review work is done with the incumbent skill on development
 * tasks and each wrong outcome is recorded as a verified failure observation. (Development labels
 * are available to the organization; held-out labels are not.)
 */
export async function observeReviewWork(rt: Runtime, gate: Gate, opts: { seed?: string; n?: number } = {}): Promise<{ observation_ids: string[]; by_class: Record<string, number>; reviewed: number; accuracy: number }> {
  const active = rt.registry.manifest(rt.registry.active());
  const dir = rt.registry.componentDir('execution', active.components.execution.version);
  const batch = { seed: opts.seed ?? 'observed-work-1', n: opts.n ?? 40, release_id: active.release_id };
  const cases = devCases(batch.seed, batch.n);
  const res = await gate.scoreBundle(dir, 'change-review', cases);
  noteObservedBatch(rt, batch);
  const ids: string[] = [];
  const by_class: Record<string, number> = {};
  cases.forEach((c, i) => {
    const s = res.scores[i]!;
    if (s.correct) return;
    by_class[c.label.defect_class] = (by_class[c.label.defect_class] ?? 0) + 1;
    const o = rt.kernel.observe({ mission_id: null, task_id: null, kind: s.escaped_defect ? 'escaped_defect' : 'acceptance_failure', failure_class: c.label.defect_class, certainty: 'verified', details: { case_id: c.case.id, title: c.case.title, severity: c.label.severity, outcome: s.escaped_defect ? 'a breaking change was approved' : 'a safe change was blocked' }, component: 'execution:change-review', release_id: active.release_id, source: 'fixture' });
    ids.push(o.id);
  });
  rt.store.emit({ type: 'outcomes_observed', actor_id: 'evolution-swarm', actor_kind: 'agent', payload: { skill: 'change-review', release_id: active.release_id, reviewed: cases.length, failures: ids.length, by_class, source: 'fixture' } });
  return { observation_ids: ids, by_class, reviewed: cases.length, accuracy: res.metrics.accuracy };
}

/**
 * Steps 2–9 for one execution-level candidate: state the hypothesis, freeze the protocol, build
 * the candidate in an isolated workspace, run development checks, hand the bundle to the gate,
 * and receive its decision. The author never sees held-out cases or their labels.
 */
export async function runExperiment(rt: Runtime, gate: Gate, candidate: string, opts: { revises_experiment?: string | null; observation_ids?: string[]; force_execute_despite_screening?: boolean; spec_dir?: string } = {}): Promise<{ experiment: Experiment; receipt: ImprovementReceipt; built: BuiltCandidate; dev: { accuracy: number; cases: number } | null }> {
  const specDir = opts.spec_dir ?? join(CANDIDATE_LIBRARY, candidate);
  const spec = JSON.parse((await import('node:fs')).readFileSync(join(specDir, 'candidate.json'), 'utf8')) as CandidateSpec;
  const related = (opts.observation_ids ?? rt.store.observations.where(`"component" = 'execution:change-review'`).map((o) => o.id)).filter((id) => {
    const o = rt.store.observations.get(id);
    return o && (spec.failure_classes.length === 0 || spec.failure_classes.includes(o.failure_class));
  });
  const exp = gate.openExperiment({ level: spec.level, title: spec.title, problem: { statement: spec.problem, observation_ids: related, observed_failure_count: related.length }, hypothesis: spec.hypothesis, expected_benefit: spec.expected_benefit, possible_regressions: spec.possible_regressions, declared_simplification: spec.declared_simplification, revises_experiment: opts.revises_experiment ?? null });
  rt.store.emit({ type: 'hypothesis_stated', actor_id: 'evolution-swarm', actor_kind: 'agent', payload: { experiment_id: exp.id, candidate, hypothesis: spec.hypothesis, observations: related.length } });

  const active = rt.registry.manifest(rt.registry.active());
  const parentDir = rt.registry.componentDir(spec.level, active.components[spec.level].version);
  const built = buildCandidate(parentDir, specDir, join(rt.paths.candidates, exp.id, 'workspace'), { __REPO_ROOT__: REPO_ROOT, __SWARM2_HOME__: rt.paths.home });

  // Development checks on cases the author may see. They inform the author; they decide nothing.
  let dev: { accuracy: number; cases: number } | null = null;
  if (spec.level === 'execution' && gate.staticScreen(built.dir).length === 0) {
    const cases = devCases('dev-1', 40);
    try {
      const res = await gate.scoreBundle(built.dir, 'change-review', cases);
      dev = { accuracy: res.metrics.accuracy, cases: cases.length };
    } catch {
      dev = null; // a candidate that cannot run on development cases is still submitted; the gate will say why it fails
    }
  }
  gate.submitCandidate(exp.id, built);
  if (dev) gate.recordDevelopment(exp.id, 'development check by the candidate author', dev.cases, { accuracy: Number(dev.accuracy.toFixed(4)) });
  if (spec.level === 'evolution' && gate.staticScreen(built.dir).length === 0) {
    // The policy author may run the arena on any episode that is not a registered held-out one.
    const seeds = Array.from({ length: 8 }, (_, i) => `arena-dev-${i}`);
    const module = (JSON.parse((await import('node:fs')).readFileSync(join(built.dir, 'evolution.json'), 'utf8')) as { policy_module: string }).policy_module;
    const mine = await runPolicy(gate, built.dir, module, seeds, { complaints: true });
    const theirs = await runPolicy(gate, parentDir, (JSON.parse((await import('node:fs')).readFileSync(join(parentDir, 'evolution.json'), 'utf8')) as { policy_module: string }).policy_module, seeds, { complaints: true });
    const avg = (xs: number[]): number => Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3));
    gate.recordDevelopment(exp.id, 'development episodes run by the policy author', seeds.length, { candidate_mean_benefit: avg(mine.map((r) => r.validated_benefit)), incumbent_mean_benefit: avg(theirs.map((r) => r.validated_benefit)), units: mine.concat(theirs).reduce((a, r) => a + r.spent, 0) });
  }
  const receipt = await gate.evaluate(exp.id, { force_execute_despite_screening: opts.force_execute_despite_screening });
  return { experiment: gate.experiments.must(exp.id), receipt, built, dev };
}
