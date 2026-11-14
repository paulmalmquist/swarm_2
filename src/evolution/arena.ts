import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../config.ts';
import type { GateResult, MetricComparison } from '../contracts/types.ts';
import { type Experiment, type Gate, type LevelEvaluation, RESAMPLES, gateResult } from '../gate/gate.ts';
import { CandidateProcess } from '../gate/sandbox.ts';
import { pairedBootstrapCI, round, signTest } from '../lib/stats.ts';
import { rng, seedFrom } from '../lib/util.ts';
import { type LabeledCase, type Mutation, type ReviewOutput, clone, generate, str } from '../../fixtures/evolution/review-cases.ts';
import { HOLDOUT_MUTATIONS, HOLDOUT_WEIGHTS } from '../../protected/cases/review-holdout.ts';
import { episodeSeeds } from '../../protected/cases/arena-holdout.ts';
import { type CaseScore, scoreReview } from '../../protected/checkers/review.ts';

/**
 * THE IMPROVEMENT ARENA — a synthetic testbed for comparing improvement POLICIES.
 *
 * Each episode is a world with its own mix of failures. A policy is given the same observations
 * and the same experiment budget as its rival and decides what to work on, whether to pilot,
 * what to submit and when to stop. Every fix it submits is judged on held-out cases by the same
 * rule the release gate uses, and the campaign's worth is measured afterwards on fresh cases.
 *
 * What is real: the policies are executable code making decisions from noisy observations; the
 * fixes are executable validators; every outcome is measured by running them.
 * What is synthetic: the failure distribution, and the fix library that stands in for hypothesis
 * generation. Results describe this testbed, not improvement rates in real work.
 */

const LIB_DIR = join(REPO_ROOT, 'fixtures', 'evolution', 'fix-library');

export interface Fix {
  id: string;
  file: string;
  problem_ids: string[];
  build_cost: number;
}

export function fixLibrary(): Fix[] {
  return (JSON.parse(readFileSync(join(LIB_DIR, 'library.json'), 'utf8')) as { fixes: Fix[] }).fixes;
}

/** A safe change that people complain about: an optional field whose name is not snake_case. */
const STYLE_NIT: Mutation = {
  class: 'style_nit', should_block: false, severity: 0,
  apply: (b) => {
    const after = clone(b.schema);
    after.properties!.extraNotes = str('free text');
    return { after, field: null, description: `Add extraNotes to ${b.name}.`, withTests: true };
  },
};

export interface World {
  seed: string;
  weights: Record<string, number>;
  log: LabeledCase[];
  holdout: LabeledCase[];
  fresh: LabeledCase[];
  /** Reports nobody verified, per problem. */
  complaints: Record<string, number>;
}

function gaussian(r: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());
}

/** Build one episode: its own traffic mix, an observed log, a held-out sample and a fresh sample. */
export function makeWorld(seed: string, sizes: { log: number; holdout: number; fresh: number }, opts: { complaints: boolean }): World {
  const r = rng(seedFrom(`world:${seed}`));
  const mutations = [...HOLDOUT_MUTATIONS, STYLE_NIT];
  const weights: Record<string, number> = {};
  for (const m of mutations) weights[m.class] = Math.max(0.15, (HOLDOUT_WEIGHTS[m.class] ?? 1.5) * Math.exp(0.8 * gaussian(r)));
  const log = generate(`${seed}:log`, sizes.log, mutations, weights);
  const nits = log.filter((c) => c.label.defect_class === 'style_nit').length;
  return {
    seed,
    weights,
    log,
    holdout: generate(`${seed}:holdout`, sizes.holdout, mutations, weights),
    fresh: generate(`${seed}:fresh`, sizes.fresh, mutations, weights),
    // Each style nit draws several complaints; none is a verified defect.
    complaints: opts.complaints ? { style_nit: nits * (2 + Math.floor(r() * 3)) + Math.floor(r() * 12) } : {},
  };
}

/** One sandboxed process that runs validator sets for a whole evaluation. */
export class Workbench {
  private proc: CandidateProcess;
  private base: string[];
  constructor(gate: Gate, base: string[]) {
    this.base = base;
    this.proc = new CandidateProcess(LIB_DIR, { iso: gate.iso, allowRead: [...new Set(base.map((b) => join(b, '..')))] });
  }
  async review(fixFiles: string[], cases: LabeledCase[]): Promise<Map<string, ReviewOutput>> {
    const res = await this.proc.request('review_set', { files: [...this.base, ...fixFiles.map((f) => join(LIB_DIR, f))], cases: cases.map((c) => c.case) }, 60_000);
    if (!res.ok) throw new Error(`workbench failed: ${String(res.error)}`);
    return new Map((res.outputs as (ReviewOutput & { id: string })[]).map((o) => [o.id, o]));
  }
  close(): void {
    this.proc.close();
  }
}

function scoreAll(cases: LabeledCase[], out: Map<string, ReviewOutput>): CaseScore[] {
  return cases.map((c) => scoreReview(c.label, out.get(c.case.id) ?? null));
}

function harmPer100(scores: CaseScore[]): number {
  return (100 * scores.reduce((a, s) => a + s.harm, 0)) / Math.max(1, scores.length);
}

/** The held-out judgement of one fix, by the same rule the release gate applies to a skill candidate. */
function judge(cases: LabeledCase[], champion: CaseScore[], candidate: CaseScore[], seed: number, falseAlarmMargin: number): 'accept' | 'reject' | 'inconclusive' {
  const blocking = Math.max(1, cases.filter((c) => c.label.should_block).length);
  const safe = Math.max(1, cases.length - blocking);
  const rate = (xs: CaseScore[], f: (s: CaseScore) => boolean, n: number): number => xs.filter(f).length / n;
  if (rate(candidate, (s) => s.escaped_defect, blocking) > rate(champion, (s) => s.escaped_defect, blocking) + 1e-9) return 'reject';
  if (rate(candidate, (s) => s.false_alarm, safe) > rate(champion, (s) => s.false_alarm, safe) + falseAlarmMargin + 1e-9) return 'reject';
  const ci = pairedBootstrapCI(candidate.map((s, i) => (s.correct ? 1 : 0) - (champion[i]!.correct ? 1 : 0)), { seed, iterations: 800 });
  return ci.lo > 0 ? 'accept' : ci.hi < 0 ? 'reject' : 'inconclusive';
}

export interface CampaignResult {
  seed: string;
  budget: number;
  spent: number;
  steps: number;
  accepted: string[];
  rejected: string[];
  inconclusive: string[];
  pruned: string[];
  /** Units spent on fixes that were built or submitted and not accepted. */
  failed_cost: number;
  pilot_cost: number;
  invalid_actions: number;
  ended: 'stop' | 'budget' | 'max_steps' | 'invalid' | 'error';
  harm_before: number;
  harm_after: number;
  /** Severity-weighted harm avoided per 100 reviews, measured on fresh cases after the campaign. */
  validated_benefit: number;
}

interface CandState extends Fix {
  built: boolean;
  pilot: { cases: number; attempted: number; fixed: number; broke: number } | null;
  submitted: boolean;
  result: string | null;
  cost_so_far: number;
}

/** Run one improvement campaign: a policy, a world and a budget. */
export async function campaign(bench: Workbench, policy: CandidateProcess, world: World, p: { budget: number; submit_cost: number; max_steps: number; false_alarm_margin: number }): Promise<CampaignResult> {
  const fixes: CandState[] = fixLibrary().map((f) => ({ ...f, built: false, pilot: null, submitted: false, result: null, cost_so_far: 0 }));
  const champion: string[] = [];
  let budget = p.budget;
  let invalid = 0;
  let pilot_cost = 0;
  let ended: CampaignResult['ended'] = 'max_steps';
  let steps = 0;

  let logScores = scoreAll(world.log, await bench.review([], world.log));
  const failing0 = new Map<string, LabeledCase[]>();
  world.log.forEach((c, i) => {
    if (!logScores[i]!.correct) failing0.set(c.label.defect_class, [...(failing0.get(c.label.defect_class) ?? []), c]);
  });
  const problemIds = [...new Set([...failing0.keys(), ...Object.keys(world.complaints)])].sort();
  const resolved = new Set<string>();
  const problems = () =>
    problemIds.map((id) => {
      const verified = failing0.get(id) ?? [];
      return { id, verified_count: verified.length, observed_count: verified.length + (world.complaints[id] ?? 0), severity: verified.length ? verified.reduce((a, c) => a + c.label.severity, 0) / verified.length : 0, resolved: resolved.has(id) };
    });

  while (steps < p.max_steps) {
    steps++;
    const state = { step: steps, budget_remaining: budget, costs: { pilot_per_case: 1, submit: p.submit_cost }, problems: problems(), candidates: fixes.map((f) => ({ id: f.id, problem_ids: f.problem_ids, build_cost: f.build_cost, built: f.built, pilot: f.pilot, submitted: f.submitted, result: f.result })) };
    let action: { type?: string; candidate_id?: string; cases?: number };
    try {
      const res = await policy.request('decide', { state }, 5_000);
      if (!res.ok) throw new Error(String(res.error));
      action = res.action as typeof action;
    } catch {
      ended = 'error';
      break;
    }
    if (action.type === 'stop') {
      ended = 'stop';
      break;
    }
    const f = fixes.find((x) => x.id === action.candidate_id);
    const refuse = (): void => {
      invalid++;
    };
    if (!f) refuse();
    else if (action.type === 'build') {
      if (f.built || f.build_cost > budget) refuse();
      else {
        budget -= f.build_cost;
        f.cost_so_far += f.build_cost;
        f.built = true;
      }
    } else if (action.type === 'pilot') {
      const k = Math.max(2, Math.min(24, Math.floor(Number(action.cases ?? 8))));
      if (!f.built || f.submitted || k > budget) refuse();
      else {
        // Pilot cases are observed cases: failures the fix targets, and cases the skill already handles.
        const targets = f.problem_ids.flatMap((id) => failing0.get(id) ?? []).slice(0, Math.ceil(k / 2));
        const working = world.log.filter((c, i) => logScores[i]!.correct).slice(0, k - targets.length);
        const cases = [...targets, ...working];
        const before = scoreAll(cases, await bench.review(champion, cases));
        const after = scoreAll(cases, await bench.review([...champion, f.file], cases));
        f.pilot = { cases: cases.length, attempted: targets.length, fixed: targets.filter((_, i) => !before[i]!.correct && after[i]!.correct).length, broke: cases.filter((_, i) => before[i]!.correct && !after[i]!.correct).length };
        budget -= cases.length;
        pilot_cost += cases.length;
        f.cost_so_far += cases.length;
      }
    } else if (action.type === 'submit') {
      if (!f.built || f.submitted || p.submit_cost > budget) refuse();
      else {
        budget -= p.submit_cost;
        f.cost_so_far += p.submit_cost;
        f.submitted = true;
        const champ = scoreAll(world.holdout, await bench.review(champion, world.holdout));
        const cand = scoreAll(world.holdout, await bench.review([...champion, f.file], world.holdout));
        f.result = judge(world.holdout, champ, cand, seedFrom(`${world.seed}:${f.id}`), p.false_alarm_margin);
        if (f.result === 'accept') {
          champion.push(f.file);
          logScores = scoreAll(world.log, await bench.review(champion, world.log));
          for (const [id, cases] of failing0) {
            const still = cases.filter((c) => !logScores[world.log.indexOf(c)]!.correct).length;
            if (still <= 0.2 * cases.length) resolved.add(id);
          }
        }
      }
    } else refuse();
    if (invalid > 5) {
      ended = 'invalid';
      break;
    }
    if (budget <= 0) {
      ended = 'budget';
      break;
    }
  }
  const before = harmPer100(scoreAll(world.fresh, await bench.review([], world.fresh)));
  const after = harmPer100(scoreAll(world.fresh, await bench.review(champion, world.fresh)));
  const by = (r: string) => fixes.filter((f) => f.result === r).map((f) => f.id);
  return {
    seed: world.seed,
    budget: p.budget,
    spent: p.budget - budget,
    steps,
    accepted: by('accept'),
    rejected: by('reject'),
    inconclusive: by('inconclusive'),
    pruned: fixes.filter((f) => f.built && !f.submitted).map((f) => f.id),
    failed_cost: fixes.filter((f) => f.result !== 'accept').reduce((a, f) => a + f.cost_so_far, 0),
    pilot_cost,
    invalid_actions: invalid,
    ended,
    harm_before: before,
    harm_after: after,
    validated_benefit: before - after,
  };
}

/** Run a policy bundle over a list of episodes. */
export async function runPolicy(gate: Gate, policyDir: string, module: string, seeds: string[], opts: { complaints: boolean }): Promise<CampaignResult[]> {
  const pol = gate.policy().levels.evolution as unknown as { budget_units: number; submit_cost_units: number; log_cases: number; holdout_cases: number; fresh_cases: number; false_alarm_margin: number; max_steps: number };
  const incumbentExec = gate.stageForSandbox(gate.rt.registry.componentDir('execution', gate.rt.registry.manifest(gate.rt.registry.baseline()).components.execution.version));
  const base = (JSON.parse(readFileSync(join(incumbentExec, 'execution.json'), 'utf8')) as { skills: Record<string, { validators: string[] }> }).skills['change-review']!.validators.map((v) => join(incumbentExec, 'validators', v));
  const dir = gate.stageForSandbox(policyDir);
  const bench = new Workbench(gate, base);
  const policy = new CandidateProcess(dir, { iso: gate.iso });
  try {
    const loaded = await policy.request('load_policy', { bundle_dir: dir, module });
    if (!loaded.ok) throw new Error(`policy could not be loaded: ${String(loaded.error)}`);
    const out: CampaignResult[] = [];
    for (const seed of seeds) {
      const world = makeWorld(seed, { log: pol.log_cases, holdout: pol.holdout_cases, fresh: pol.fresh_cases }, opts);
      out.push(await campaign(bench, policy, world, { budget: pol.budget_units, submit_cost: pol.submit_cost_units, max_steps: pol.max_steps, false_alarm_margin: pol.false_alarm_margin }));
    }
    return out;
  } finally {
    policy.close();
    bench.close();
  }
}

function moduleOf(dir: string): string {
  return (JSON.parse(readFileSync(join(dir, 'evolution.json'), 'utf8')) as { policy_module: string }).policy_module;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/**
 * Level 3 evaluation: the candidate improvement policy against the incumbent, with equal budgets,
 * on the same unseen failure episodes. The measure is independently validated harm reduction,
 * together with what each policy spent on experiments that failed.
 */
export async function evaluateEvolution(gate: Gate, exp: Experiment): Promise<LevelEvaluation> {
  const pol = gate.policy().levels.evolution;
  const { registry } = gate.rt;
  const cand = exp.candidate!;
  const set = exp.protocol!.holdout_set;
  const gates: GateResult[] = [];
  const limitations = [
    'The arena is a synthetic testbed. Its failure distribution is invented and its fix library stands in for hypothesis generation; the result describes behaviour in this testbed, not improvement rates in real work.',
    'By construction the arena contains a frequently reported, never verified complaint class. The comparison is repeated without it as a sensitivity check; only the main comparison decides.',
    'Policies and validators are deterministic, so each episode is run once. The interval reflects which episodes were drawn.',
    'Both policies were written by the same author who built the arena.',
  ];
  const screening = gate.staticScreen(cand.ingested_dir);
  gates.push(gateResult('no_forbidden_capabilities', 'No forbidden capabilities', 'HARD_GATE', screening.length ? 'FAILED' : 'PASSED', screening.length ? `The policy uses capabilities it has no reason to use: ${screening.join('; ')}` : 'The policy code uses no file, process, network or dynamic-code capability.'));
  gates.push(gateResult('holdout_not_reused', 'Episodes are unseen by this lineage', 'HARD_GATE', set ? 'PASSED' : 'REMAINING', set ? `Run on episode set ${set}, which this lineage has not been scored on.` : 'No unused episode set is registered for this lineage.'));
  if (screening.length || !set) {
    for (const g of ['minimum_samples', 'budget_respected', 'policy_terminates']) gates.push(gateResult(g, g.replace(/_/g, ' '), 'HARD_GATE', 'REMAINING', 'Not measured: the policy was not executed.'));
    return { comparisons: [], gates, primary: null, cost: null, known_regressions: [], limitations, units: 0, snapshot: { screening, executed: false }, executor: 'improvement-arena', deterministic: true, cases: 0 };
  }
  gate.db.run('INSERT INTO holdout_usage (lineage_id, level, set_id, experiment_id, at) VALUES (?, ?, ?, ?, ?)', exp.lineage_id, 'evolution', set, exp.id, gate.rt.store.clock.iso());
  const seeds = episodeSeeds(set, pol.holdout_episodes);
  const incDir = registry.componentDir('evolution', registry.manifest(exp.incumbent_release).components.evolution.version);
  const baseDir = registry.componentDir('evolution', registry.manifest(exp.baseline_release).components.evolution.version);
  const incumbent = await runPolicy(gate, incDir, moduleOf(incDir), seeds, { complaints: true });
  const baseline = incDir === baseDir ? incumbent : await runPolicy(gate, baseDir, moduleOf(baseDir), seeds, { complaints: true });
  const candidate = await runPolicy(gate, cand.ingested_dir, moduleOf(cand.ingested_dir), seeds, { complaints: true });
  // Sensitivity: the same episodes without the unverified complaint class.
  const incQuiet = await runPolicy(gate, incDir, moduleOf(incDir), seeds, { complaints: false });
  const candQuiet = await runPolicy(gate, cand.ingested_dir, moduleOf(cand.ingested_dir), seeds, { complaints: false });

  const budget = (pol as unknown as { budget_units: number }).budget_units;
  const over = candidate.filter((r) => r.spent > budget + 1e-9).length;
  const invalid = candidate.reduce((a, r) => a + r.invalid_actions, 0);
  const runaway = candidate.filter((r) => r.ended === 'max_steps' || r.ended === 'error' || r.ended === 'invalid').length;
  gates.push(gateResult('minimum_samples', 'Enough episodes', 'HARD_GATE', candidate.length >= pol.minimum_samples ? 'PASSED' : 'FAILED', `${candidate.length} episodes run; at least ${pol.minimum_samples} are required.`, { measurement_value: candidate.length, measurement_unit: 'episodes', comparison_operator: '>=', threshold: pol.minimum_samples, samples: candidate.length, minimum_samples: pol.minimum_samples }));
  gates.push(gateResult('budget_respected', 'The experiment budget is respected', 'HARD_GATE', over === 0 && invalid === 0 ? 'PASSED' : 'FAILED', `Episodes over budget: ${over}. Actions the arena had to refuse (unaffordable or malformed): ${invalid}.`, { measurement_value: over + invalid, measurement_unit: 'violations', comparison_operator: '=', threshold: 0, samples: candidate.length, minimum_samples: pol.minimum_samples }));
  gates.push(gateResult('policy_terminates', 'Every campaign ends on its own', 'HARD_GATE', runaway === 0 ? 'PASSED' : 'FAILED', `Campaigns that hit the step limit or failed: ${runaway}.`, { measurement_value: runaway, measurement_unit: 'campaigns', comparison_operator: '=', threshold: 0, samples: candidate.length, minimum_samples: pol.minimum_samples }));

  const seed = seedFrom(`${cand.candidate_hash}:${set}`);
  const paired = (metric: string, unit: string, higher: boolean, pick: (r: CampaignResult) => number, c: CampaignResult[], i: CampaignResult[], b: CampaignResult[], s: number): MetricComparison => {
    const dI = c.map((r, k) => pick(r) - pick(i[k]!));
    const dB = c.map((r, k) => pick(r) - pick(b[k]!));
    const ci = pairedBootstrapCI(dI, { seed: s, iterations: RESAMPLES });
    const cb = pairedBootstrapCI(dB, { seed: s + 1, iterations: RESAMPLES });
    const st = signTest(dI);
    return { metric, unit, higher_is_better: higher, candidate: round(mean(c.map(pick))), incumbent: round(mean(i.map(pick))), baseline: round(mean(b.map(pick))), diff_vs_incumbent: round(ci.mean), ci95_vs_incumbent: [round(ci.lo)!, round(ci.hi)!], diff_vs_baseline: round(cb.mean), ci95_vs_baseline: [round(cb.lo)!, round(cb.hi)!], n: c.length, method: `paired bootstrap over the same ${c.length} episodes (${RESAMPLES} resamples, seeded); sign test: ${st.wins} better, ${st.losses} worse, ${st.ties} same, p=${round(st.p, 5)}` };
  };
  const primary = paired('validated_benefit', 'severity-weighted harm avoided per 100 reviews, measured on fresh cases', true, (r) => r.validated_benefit, candidate, incumbent, baseline, seed);
  const improvements = paired('validated_improvements', 'fixes accepted on held-out cases per campaign', true, (r) => r.accepted.length, candidate, incumbent, baseline, seed + 2);
  const failed = paired('failed_experiment_cost', 'budget units spent on fixes that were not accepted', false, (r) => r.failed_cost, candidate, incumbent, baseline, seed + 4);
  const spent = paired('budget_spent', `units of an equal budget of ${budget}`, false, (r) => r.spent, candidate, incumbent, baseline, seed + 6);
  const perUnit = paired('validated_benefit_per_100_units', 'harm avoided per 100 budget units actually spent', true, (r) => (r.spent > 0 ? (100 * r.validated_benefit) / r.spent : 0), candidate, incumbent, baseline, seed + 8);
  const quiet = paired('validated_benefit_without_unverified_complaints', 'sensitivity check: same episodes with no unverified complaint class', true, (r) => r.validated_benefit, candQuiet, incQuiet, incQuiet, seed + 10);

  gates.push(gateResult('benefit_gain', 'Validated benefit at equal budget', 'WEIGHTED', primary.diff_vs_incumbent! > 0 ? 'PASSED' : 'FAILED', `Validated benefit changed by ${primary.diff_vs_incumbent} (95% interval ${primary.ci95_vs_incumbent![0]} to ${primary.ci95_vs_incumbent![1]}).`, { measurement_value: primary.diff_vs_incumbent, measurement_unit: 'harm avoided per 100 reviews', comparison_operator: '>', threshold: 0, weight: 0.7, samples: candidate.length, minimum_samples: pol.minimum_samples }));
  gates.push(gateResult('failed_cost', 'Cost of failed experiments', 'WEIGHTED', failed.diff_vs_incumbent! <= 0 ? 'PASSED' : 'FAILED', `Budget spent on fixes that failed changed by ${failed.diff_vs_incumbent} units per campaign.`, { measurement_value: failed.diff_vs_incumbent, measurement_unit: 'budget units', comparison_operator: '<=', threshold: 0, weight: 0.3, samples: candidate.length, minimum_samples: pol.minimum_samples }));

  const known_regressions: string[] = [];
  const worse = candidate.filter((r, k) => r.validated_benefit < incumbent[k]!.validated_benefit - 1e-9).length;
  if (worse) known_regressions.push(`In ${worse} of ${candidate.length} episodes the candidate policy delivered less validated benefit than the incumbent`);
  if (quiet.ci95_vs_incumbent && quiet.ci95_vs_incumbent[0] <= 0) known_regressions.push(`Without the unverified complaint class the advantage is not demonstrated (difference ${quiet.diff_vs_incumbent}, 95% interval ${quiet.ci95_vs_incumbent[0]} to ${quiet.ci95_vs_incumbent[1]})`);
  const units = [incumbent, candidate, incQuiet, candQuiet, ...(baseline === incumbent ? [] : [baseline])].flat().reduce((a, r) => a + r.spent, 0);
  const tally = (rs: CampaignResult[]) => ({ accepted: rs.reduce((a, r) => a + r.accepted.length, 0), rejected: rs.reduce((a, r) => a + r.rejected.length, 0), inconclusive: rs.reduce((a, r) => a + r.inconclusive.length, 0), pruned_before_submission: rs.reduce((a, r) => a + r.pruned.length, 0), ended: rs.reduce((a: Record<string, number>, r) => ((a[r.ended] = (a[r.ended] ?? 0) + 1), a), {}) });
  return {
    comparisons: [primary, improvements, failed, spent, perUnit, quiet],
    gates,
    primary,
    cost: failed,
    known_regressions,
    limitations,
    units,
    snapshot: { set, episodes: seeds.length, budget, incumbent: { tally: tally(incumbent), episodes: incumbent }, candidate: { tally: tally(candidate), episodes: candidate }, sensitivity: { incumbent: tally(incQuiet), candidate: tally(candQuiet) } },
    executor: 'improvement-arena',
    deterministic: true,
    cases: seeds.length,
  };
}

export function installArena(gate: Gate): void {
  gate.evaluators.evolution = evaluateEvolution;
}
