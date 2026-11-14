import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../config.ts';
import type { IsolationCapability } from '../contracts/runtime.ts';
import type { CanaryRecord, ComponentLevel, ExperimentDecision, ExperimentStage, GateResult, ImprovementReceipt, IsolationReport, MetricComparison, ReleaseManifest, Sha256, SourceLabel } from '../contracts/types.ts';
import type { BuiltCandidate, CandidateSpec } from '../evolution/candidates.ts';
import type { Runtime } from '../runtime.ts';
import { Db, Repo } from '../store/db.ts';
import { SwarmError, canonicalize, hashOf, newId, seedFrom, sha256 } from '../lib/util.ts';
import { pairedBootstrapCI, round, signTest } from '../lib/stats.ts';
import { hashDir } from './registry.ts';
import { CandidateProcess, detectIsolation } from './sandbox.ts';
import { type CaseScore, scoreReview } from '../../protected/checkers/review.ts';
import { HOLDOUT_SETS, freshCases, holdoutCases, requiredStepProbes } from '../../protected/cases/review-holdout.ts';
import { ARENA_SETS, COORDINATION_SETS } from '../../protected/cases/arena-holdout.ts';
import type { LabeledCase, ReviewOutput } from '../../fixtures/evolution/review-cases.ts';

export const PROTECTED_SRC = join(REPO_ROOT, 'protected');
/** Enough resamples that an interval bound does not move with the resampling noise. */
export const RESAMPLES = 20000;

export interface PromotionPolicy {
  policy_id: string;
  version: number;
  levels: {
    execution: { workload: string; holdout_cases: number; minimum_samples: number; repeats_when_stochastic: number; primary_metric: string; non_inferiority_margin: number; false_alarm_margin: number; required_steps: Record<string, string[]>; max_cost_ratio: number };
    coordination: { workload: string; holdout_episodes: number; minimum_samples: number; primary_metric: string; non_inferiority_margin: number };
    evolution: { workload: string; holdout_episodes: number; minimum_samples: number; budget_units: number; primary_metric: string; non_inferiority_margin: number };
  };
  forbidden_capabilities: string[];
  holdout: { max_uses_per_lineage: number; max_total_uses_per_set?: number };
  exploration?: { budget_units: number };
  canary: { max_missions: number; fresh_cases: number; rollback_if: { accuracy_drop_gt: number; escaped_defect_rate_increase_gt: number; acceptance_failures_gt: number; policy_refused_actions_gt?: number } };
  decision_rule: Record<string, string>;
}

export interface Experiment {
  id: string;
  level: ComponentLevel;
  stage: ExperimentStage;
  title: string;
  problem: { statement: string; observation_ids: string[]; observed_failure_count: number };
  hypothesis: string;
  expected_benefit: string;
  possible_regressions: string[];
  declared_simplification: boolean;
  lineage_id: string;
  revises: string | null;
  incumbent_release: string;
  baseline_release: string;
  parent: { component: ComponentLevel; version: number; content_hash: Sha256 };
  protocol: { protocol_id: string; policy_hash: Sha256; protected_digest: Sha256; holdout_set: string | null; workload: string; cases: number; frozen_at: string; executor: string } | null;
  budget_units: number;
  candidate: { candidate_id: string; ingested_dir: string; candidate_hash: Sha256; files: BuiltCandidate['files']; summary: string } | null;
  decision: ExperimentDecision | null;
  receipt_id: string | null;
  release_id: string | null;
  canary_id: string | null;
  source: Exclude<SourceLabel, 'unavailable'>;
  created_at: string;
  updated_at: string;
}

export interface ArmMetrics {
  n: number;
  accuracy: number;
  escaped_defect_rate: number;
  false_alarm_rate: number;
  harm_per_case: number;
  steps: number;
  wall_ms_per_case: number;
  by_class: Record<string, { n: number; correct: number }>;
  errors: number;
}

export interface LevelEvaluation {
  comparisons: MetricComparison[];
  gates: GateResult[];
  primary: MetricComparison | null;
  cost: MetricComparison | null;
  known_regressions: string[];
  limitations: string[];
  units: number;
  snapshot: unknown;
  executor: string;
  deterministic: boolean;
  cases: number;
}

export function gateResult(id: string, name: string, kind: GateResult['kind'], verdict: GateResult['verdict'], meaning: string, m: Partial<GateResult> = {}): GateResult {
  return { id, name, kind, verdict, measurement_value: null, measurement_unit: null, comparison_operator: '=', threshold: null, samples: 0, minimum_samples: 0, weight: null, meaning, ...m };
}

/**
 * The release gate: the only component with promotion authority.
 *
 * Candidate authors submit a bundle and a hypothesis. The gate freezes the protocol before it
 * looks at the candidate, runs candidate code under reduced privileges against held-out cases the
 * author never sees, scores it with protected rules, and writes the decision, the receipt and —
 * if the candidate qualifies — a new release manifest. A candidate cannot change the rules used
 * to approve itself: the rules, the held-out cases, the records and the registry live outside
 * anything candidate code can write.
 */
export class Gate {
  rt: Runtime;
  db: Db;
  experiments: Repo<Experiment>;
  receipts: Repo<ImprovementReceipt & { id: string }>;
  canaries: Repo<CanaryRecord>;
  iso: IsolationCapability;

  constructor(rt: Runtime) {
    this.rt = rt;
    mkdirSync(rt.paths.protected, { recursive: true });
    this.iso = detectIsolation();
    this.db = new Db(rt.paths.gateDb);
    this.experiments = new Repo(this.db, 'experiments', ['level', 'stage', 'decision', 'lineage_id', 'release_id']);
    this.receipts = new Repo(this.db, 'receipts', ['experiment_id', 'decision', 'level']);
    this.canaries = new Repo(this.db, 'canaries', ['release_id', 'status']);
    this.db.tx(() => {
      for (const r of [this.experiments, this.receipts, this.canaries]) this.db.exec((r as Repo<{ id: string }>).ddl());
      this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      this.db.exec('CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT, kind TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)');
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'the evaluation ledger is append-only'); END`);
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'the evaluation ledger is append-only'); END`);
      this.db.exec('CREATE TABLE IF NOT EXISTS holdout_usage (lineage_id TEXT NOT NULL, level TEXT NOT NULL, set_id TEXT NOT NULL, experiment_id TEXT NOT NULL, at TEXT NOT NULL)');
    });
  }

  private get clock() {
    return this.rt.store.clock;
  }

  private meta<T>(key: string): T | undefined {
    const row = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key);
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  private setMeta(key: string, value: unknown): void {
    this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  // ───────────────────────────── protected store ─────────────────────────────

  policy(): PromotionPolicy {
    return JSON.parse(readFileSync(join(PROTECTED_SRC, 'policy.json'), 'utf8')) as PromotionPolicy;
  }

  policyHash(): Sha256 {
    return sha256(readFileSync(join(PROTECTED_SRC, 'policy.json')));
  }

  protectedDigest(): Sha256 {
    return hashDir(PROTECTED_SRC);
  }

  /**
   * Seal the protected store. Where the host allows it, both the rules in the repository and the
   * records under the state directory become unreadable and unwritable to the candidate uid.
   */
  init(): { isolation: IsolationCapability; protected_digest: Sha256; active_release: string } {
    const { paths, registry } = this.rt;
    mkdirSync(join(paths.protected, 'evaluations'), { recursive: true });
    mkdirSync(paths.candidates, { recursive: true });
    if (this.iso.uid_separation) {
      chmodSync(paths.home, 0o755);
      chmodSync(paths.candidates, 0o755);
      chmodSync(paths.protected, 0o700);
      chmodSync(PROTECTED_SRC, 0o700);
    }
    if (!this.meta<string>('sealed_digest')) {
      this.setMeta('sealed_digest', this.protectedDigest());
      this.append(null, 'protected_store_sealed', { digest: this.protectedDigest(), policy_hash: this.policyHash(), isolation: this.iso.mode });
    }
    if (!registry.exists()) registry.init(join(REPO_ROOT, 'definitions'), this.policyHash(), this.clock.iso());
    return { isolation: this.iso, protected_digest: this.protectedDigest(), active_release: registry.active() };
  }

  integrity(): { ok: boolean; sealed: Sha256 | null; current: Sha256 } {
    const sealed = this.meta<string>('sealed_digest') ?? null;
    const current = this.protectedDigest();
    return { ok: sealed === current, sealed, current };
  }

  // ───────────────────────────── ledger ─────────────────────────────

  /** Every attempt is recorded: development checks, held-out evaluations, decisions, canary events. */
  append(experiment_id: string | null, kind: string, payload: Record<string, unknown>): { seq: number; hash: Sha256 } {
    return this.db.tx(() => {
      const prev = this.db.get<{ hash: string }>('SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1')?.hash ?? 'genesis';
      const at = this.clock.iso();
      const hash = sha256(prev + canonicalize({ experiment_id, kind, at, payload }));
      const r = this.db.run('INSERT INTO ledger (experiment_id, kind, at, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)', experiment_id, kind, at, JSON.stringify(payload), prev, hash);
      return { seq: r.lastInsertRowid, hash };
    });
  }

  ledger(experiment_id?: string): { seq: number; experiment_id: string | null; kind: string; at: string; payload: Record<string, unknown>; hash: string }[] {
    const rows = experiment_id ? this.db.all<Record<string, unknown>>('SELECT * FROM ledger WHERE experiment_id = ? ORDER BY seq', experiment_id) : this.db.all<Record<string, unknown>>('SELECT * FROM ledger ORDER BY seq');
    return rows.map((r) => ({ seq: Number(r.seq), experiment_id: r.experiment_id as string | null, kind: String(r.kind), at: String(r.at), payload: JSON.parse(String(r.payload)) as Record<string, unknown>, hash: String(r.hash) }));
  }

  verifyLedger(): { ok: boolean; count: number } {
    let prev = 'genesis';
    let count = 0;
    for (const r of this.db.all<Record<string, unknown>>('SELECT * FROM ledger ORDER BY seq')) {
      const expect = sha256(prev + canonicalize({ experiment_id: r.experiment_id, kind: r.kind, at: r.at, payload: JSON.parse(String(r.payload)) }));
      if (r.prev_hash !== prev || r.hash !== expect) return { ok: false, count };
      prev = String(r.hash);
      count++;
    }
    return { ok: true, count };
  }

  private mirror(type: string, payload: Record<string, unknown>): void {
    // A read-only mirror for the review interface. The ledger above is the record of authority.
    this.rt.store.emit({ type, actor_id: 'release-gate', actor_kind: 'gate', payload });
  }

  // ───────────────────────────── experiment lifecycle ─────────────────────────────

  /**
   * Steps 1–5 of the lifecycle: the problem, the falsifiable hypothesis, the component and version
   * being changed, the expected benefit and regressions — and the protocol, frozen now, before any
   * candidate exists. The held-out set is assigned here and cannot be chosen by the author.
   */
  openExperiment(input: { level: ComponentLevel; title: string; problem: Experiment['problem']; hypothesis: string; expected_benefit: string; possible_regressions: string[]; declared_simplification?: boolean; revises_experiment?: string | null; budget_units?: number; source?: Experiment['source'] }): Experiment {
    const { registry } = this.rt;
    const pol = this.policy();
    const incumbent = registry.manifest(registry.active());
    const revised = input.revises_experiment ? this.experiments.must(input.revises_experiment) : null;
    const id = newId('exp');
    const lineage_id = revised?.lineage_id ?? id;
    const sets = input.level === 'evolution' ? ARENA_SETS : input.level === 'coordination' ? COORDINATION_SETS : HOLDOUT_SETS;
    const used = this.db.all<{ set_id: string; lineage_id: string }>('SELECT set_id, lineage_id FROM holdout_usage WHERE level = ?', input.level);
    const cap = pol.holdout.max_total_uses_per_set ?? 3;
    // Never a set this lineage has already been scored on, and never one past its total exposure cap.
    const holdout_set =
      sets
        .filter((s) => !used.some((u) => u.set_id === s && u.lineage_id === lineage_id))
        .filter((s) => used.filter((u) => u.set_id === s).length < cap)
        .sort((a, b) => used.filter((u) => u.set_id === a).length - used.filter((u) => u.set_id === b).length || sets.indexOf(a) - sets.indexOf(b))[0] ?? null;
    const lv = pol.levels[input.level];
    const cases = 'holdout_cases' in lv ? lv.holdout_cases : lv.holdout_episodes;
    // Exploration is a bounded allocation: improvement work cannot crowd out everything else.
    const allocation = this.exploration();
    if (allocation.remaining <= 0) throw new SwarmError('exploration_budget_exhausted', `The exploration allocation of ${allocation.budget} experiment units is used up (${allocation.spent} spent). Raising it is a decision for the chief of staff.`, allocation);
    const now = this.clock.iso();
    const exp: Experiment = {
      id,
      level: input.level,
      stage: 'frozen',
      title: input.title,
      problem: input.problem,
      hypothesis: input.hypothesis,
      expected_benefit: input.expected_benefit,
      possible_regressions: input.possible_regressions,
      declared_simplification: input.declared_simplification ?? false,
      lineage_id,
      revises: input.revises_experiment ?? null,
      incumbent_release: incumbent.release_id,
      baseline_release: registry.baseline(),
      parent: { component: input.level, version: incumbent.components[input.level].version, content_hash: incumbent.components[input.level].content_hash },
      protocol: { protocol_id: `${pol.policy_id}@${pol.version}/${input.level}`, policy_hash: this.policyHash(), protected_digest: this.protectedDigest(), holdout_set, workload: lv.workload, cases, frozen_at: now, executor: input.level === 'execution' ? 'validator-executor' : input.level === 'evolution' ? 'improvement-arena' : 'mission-episodes' },
      budget_units: input.budget_units ?? 2000,
      candidate: null,
      decision: null,
      receipt_id: null,
      release_id: null,
      canary_id: null,
      source: input.source ?? 'fixture',
      created_at: now,
      updated_at: now,
    };
    this.experiments.put(exp);
    this.append(id, 'experiment_opened', { level: exp.level, title: exp.title, hypothesis: exp.hypothesis, lineage_id, revises: exp.revises, parent: exp.parent });
    this.append(id, 'protocol_frozen', { ...exp.protocol, budget_units: exp.budget_units, note: 'frozen before any candidate was submitted' });
    if (revised && revised.protocol?.holdout_set) {
      // Its results were revealed to the author, so for this lineage that set is now development data.
      this.append(id, 'holdout_reclassified_as_development', { lineage_id, set: revised.protocol.holdout_set, because: `experiment ${revised.id} revealed results on it` });
    }
    this.mirror('experiment_opened', { experiment_id: id, level: exp.level, title: exp.title, holdout_assigned: holdout_set !== null });
    return exp;
  }

  /** How much of the exploration allocation experiments have used so far. */
  exploration(): { budget: number; spent: number; remaining: number } {
    const budget = this.policy().exploration?.budget_units ?? Number.POSITIVE_INFINITY;
    const spent = this.receipts.where('1=1').reduce((a, r) => a + r.resource_use.experiment_units, 0);
    return { budget, spent, remaining: budget - spent };
  }

  /** Development checks run by the author on cases it is allowed to see. Recorded, never decisive. */
  recordDevelopment(experiment_id: string, note: string, cases: number, summary: Record<string, unknown>): void {
    const exp = this.experiments.must(experiment_id);
    this.append(experiment_id, 'development_attempt', { note, cases, ...summary });
    if (exp.stage === 'candidate_built') this.experiments.put({ ...exp, stage: 'dev_checked', updated_at: this.clock.iso() });
  }

  /**
   * Take custody of a candidate bundle. The gate keeps its own copy, owned by the gate and only
   * readable by candidate code, and evaluates exactly those bytes.
   */
  submitCandidate(experiment_id: string, built: BuiltCandidate): Experiment {
    const exp = this.experiments.must(experiment_id);
    if (exp.candidate) throw new SwarmError('candidate_already_submitted', `Experiment ${experiment_id} already has a candidate; a revision is a new experiment`);
    if (built.spec.level !== exp.level) throw new SwarmError('level_mismatch', `Experiment is ${exp.level}; candidate is ${built.spec.level}`);
    if (built.parent_hash !== exp.parent.content_hash) throw new SwarmError('stale_parent', 'The candidate was built from a different parent version than the one this experiment froze');
    const dest = join(this.rt.paths.candidates, experiment_id, 'ingested');
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(built.dir, dest, { recursive: true });
    const lock = (d: string): void => {
      chmodSync(d, 0o755);
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) lock(p);
        else chmodSync(p, 0o644);
      }
    };
    lock(join(this.rt.paths.candidates, experiment_id));
    const candidate_hash = hashDir(dest);
    if (candidate_hash !== built.content_hash) throw new SwarmError('candidate_changed', 'The bundle changed while it was being submitted');
    const next: Experiment = { ...exp, stage: 'candidate_built', candidate: { candidate_id: built.spec.candidate_id, ingested_dir: dest, candidate_hash, files: built.files, summary: built.spec.change_summary }, updated_at: this.clock.iso() };
    this.experiments.put(next);
    this.append(experiment_id, 'candidate_submitted', { candidate_id: built.spec.candidate_id, candidate_hash, files: built.files.map((f) => f.path) });
    this.mirror('candidate_submitted', { experiment_id, candidate_id: built.spec.candidate_id, candidate_hash });
    return next;
  }

  /** Look for capabilities a candidate has no reason to use. Runs before any candidate code does. */
  staticScreen(dir: string): string[] {
    const hits: string[] = [];
    const forbidden = this.policy().forbidden_capabilities;
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(mjs|js|cjs|ts)$/.test(n)) {
          const text = readFileSync(p, 'utf8');
          for (const f of forbidden) if (text.includes(f)) hits.push(`${p.slice(dir.length + 1)} uses ${f}`);
        }
      }
    };
    walk(dir);
    return hits;
  }

  // ───────────────────────────── execution-level evaluation ─────────────────────────────

  /**
   * Reference bundles live in the protected registry, which the sandbox user cannot read.
   * To run one in the sandbox it is copied, read-only, to a staging area named by its content hash.
   */
  stageForSandbox(dir: string): string {
    if (!dir.startsWith(this.rt.paths.protected)) return dir;
    const dest = join(this.rt.paths.candidates, '_reference', hashDir(dir));
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
      cpSync(dir, dest, { recursive: true });
      const open = (d: string): void => {
        chmodSync(d, 0o755);
        for (const n of readdirSync(d)) {
          const p = join(d, n);
          if (statSync(p).isDirectory()) open(p);
          else chmodSync(p, 0o644);
        }
      };
      open(join(this.rt.paths.candidates, '_reference'));
    }
    return dest;
  }

  private async runSkillArm(sourceDir: string, skill_id: string, cases: LabeledCase[]): Promise<{ outputs: Map<string, ReviewOutput>; wall_ms: number; steps: number; error: string | null; advisories: string[] }> {
    const dir = this.stageForSandbox(sourceDir);
    const proc = new CandidateProcess(dir, { iso: this.iso });
    const outputs = new Map<string, ReviewOutput>();
    try {
      const load = await proc.request('load_skill', { bundle_dir: dir, skill_id });
      if (!load.ok) return { outputs, wall_ms: 0, steps: 0, error: String(load.error), advisories: [] };
      const steps = (load.validators as string[]).length;
      // Cost is measured from outside the candidate process, which could otherwise misreport it.
      const t0 = performance.now();
      const res = await proc.request('review', { cases: cases.map((c) => c.case) }, 60_000);
      const wall_ms = performance.now() - t0;
      if (!res.ok) return { outputs, wall_ms, steps, error: String(res.error), advisories: [] };
      const advisories = new Set<string>();
      for (const o of res.outputs as (ReviewOutput & { id: string })[]) {
        outputs.set(o.id, o);
        for (const f of o.findings ?? []) if (f.class === 'tamper_attempt') advisories.add(f.message);
      }
      return { outputs, wall_ms, steps, error: null, advisories: [...advisories] };
    } catch (err) {
      return { outputs, wall_ms: 0, steps: 0, error: err instanceof Error ? err.message : String(err), advisories: [] };
    } finally {
      proc.close();
    }
  }

  private metrics(cases: LabeledCase[], arm: { outputs: Map<string, ReviewOutput>; wall_ms: number; steps: number }): { m: ArmMetrics; scores: CaseScore[] } {
    const scores = cases.map((c) => scoreReview(c.label, arm.outputs.get(c.case.id) ?? null));
    const blocking = cases.filter((c) => c.label.should_block).length;
    const safe = cases.length - blocking;
    const by_class: ArmMetrics['by_class'] = {};
    cases.forEach((c, i) => {
      const k = (by_class[c.label.defect_class] ??= { n: 0, correct: 0 });
      k.n++;
      if (scores[i]!.correct) k.correct++;
    });
    return {
      scores,
      m: {
        n: cases.length,
        accuracy: scores.filter((s) => s.correct).length / Math.max(1, cases.length),
        escaped_defect_rate: scores.filter((s) => s.escaped_defect).length / Math.max(1, blocking),
        false_alarm_rate: scores.filter((s) => s.false_alarm).length / Math.max(1, safe),
        harm_per_case: scores.reduce((a, s) => a + s.harm, 0) / Math.max(1, cases.length),
        steps: arm.steps,
        wall_ms_per_case: arm.wall_ms / Math.max(1, cases.length),
        by_class,
        errors: cases.filter((c) => !arm.outputs.has(c.case.id)).length,
      },
    };
  }

  /** Evaluate a skill bundle on a set of labeled cases inside the sandbox. Used for held-out and canary runs. */
  async scoreBundle(dir: string, skill_id: string, cases: LabeledCase[]): Promise<{ metrics: ArmMetrics; scores: CaseScore[]; error: string | null; advisories: string[] }> {
    const arm = await this.runSkillArm(dir, skill_id, cases);
    if (arm.error) throw new SwarmError('bundle_not_runnable', `The bundle at ${dir} could not be run in the sandbox: ${arm.error}`);
    const { m, scores } = this.metrics(cases, arm);
    return { metrics: m, scores, error: arm.error, advisories: arm.advisories };
  }

  private async evaluateExecution(exp: Experiment, opts: { force_execute_despite_screening?: boolean }): Promise<LevelEvaluation> {
    const { registry } = this.rt;
    const pol = this.policy().levels.execution;
    const skill_id = Object.keys(pol.required_steps)[0]!;
    const cand = exp.candidate!;
    const set = exp.protocol!.holdout_set;
    const gates: GateResult[] = [];
    const limitations = [
      'Evaluated by executing the skill\'s validators on synthetic change-review cases. No model was run, so this says nothing about how a model worker would use the procedure text.',
      `One deterministic pass over ${pol.holdout_cases} cases: the interval reflects which cases were drawn, not run-to-run variation.`,
      'Fixture evidence does not certify live use.',
    ];

    const screening = this.staticScreen(cand.ingested_dir);
    gates.push(gateResult('no_forbidden_capabilities', 'No forbidden capabilities', 'HARD_GATE', screening.length ? 'FAILED' : 'PASSED', screening.length ? `The candidate uses capabilities a review step has no reason to use: ${screening.join('; ')}` : 'The candidate code uses no file, process, network or dynamic-code capability.', { measurement_value: screening.length, measurement_unit: 'findings', comparison_operator: '=', threshold: 0 }));
    gates.push(gateResult('holdout_not_reused', 'Held-out cases are unseen by this lineage', 'HARD_GATE', set ? 'PASSED' : 'REMAINING', set ? `Scored on ${set}, which this candidate lineage has not been scored on before.` : 'Every registered held-out set has already been revealed to this lineage or reached its exposure cap. New held-out cases are required before another decision.'));
    if ((screening.length && !opts.force_execute_despite_screening) || !set) {
      for (const g of ['required_steps_present', 'minimum_samples', 'escaped_defects_not_worse', 'false_alarms_within_margin', 'no_regression_vs_baseline', 'cost_within_bound']) gates.push(gateResult(g, g.replace(/_/g, ' '), 'HARD_GATE', 'REMAINING', 'Not measured: the candidate was not executed.'));
      return { comparisons: [], gates, primary: null, cost: null, known_regressions: [], limitations, units: 0, snapshot: { screening, executed: false }, executor: 'validator-executor', deterministic: true, cases: 0 };
    }

    const cases = holdoutCases(set, pol.holdout_cases);
    this.db.run('INSERT INTO holdout_usage (lineage_id, level, set_id, experiment_id, at) VALUES (?, ?, ?, ?, ?)', exp.lineage_id, 'execution', set, exp.id, this.clock.iso());
    const dirs = {
      baseline: registry.componentDir('execution', registry.manifest(exp.baseline_release).components.execution.version),
      incumbent: registry.componentDir('execution', registry.manifest(exp.incumbent_release).components.execution.version),
      candidate: cand.ingested_dir,
    };
    const arms = { baseline: await this.runSkillArm(dirs.baseline, skill_id, cases), incumbent: await this.runSkillArm(dirs.incumbent, skill_id, cases), candidate: await this.runSkillArm(dirs.candidate, skill_id, cases) };
    // A comparison against a reference that did not run is not a comparison.
    for (const ref of ['baseline', 'incumbent'] as const) {
      if (arms[ref].error || arms[ref].outputs.size !== cases.length) throw new SwarmError('reference_arm_failed', `The ${ref} could not be evaluated (${arms[ref].error ?? 'missing outputs'}); no decision can be made`);
    }
    const scored = { baseline: this.metrics(cases, arms.baseline), incumbent: this.metrics(cases, arms.incumbent), candidate: this.metrics(cases, arms.candidate) };
    const c = scored.candidate.m;
    const i = scored.incumbent.m;
    const b = scored.baseline.m;

    // Required steps: declared is not enough — each must actually fire on a case with a known answer.
    const probes = requiredStepProbes().filter((p) => (pol.required_steps[skill_id] ?? []).includes(p.step));
    const probeRun = await this.runSkillArm(dirs.candidate, skill_id, probes.map((p) => ({ case: p.case, label: { should_block: true, defect_class: p.expect_class, field: null, severity: 0 } })));
    const missing = probes.filter((p) => !(probeRun.outputs.get(p.case.id)?.findings ?? []).some((f) => f.step === p.step && f.class === p.expect_class && f.severity === 'blocking')).map((p) => p.step);
    gates.push(gateResult('required_steps_present', 'Required verification steps are performed', 'HARD_GATE', missing.length ? 'FAILED' : 'PASSED', missing.length ? `The candidate omits a step that may not be omitted: ${missing.join(', ')}. A probe case with a known answer was not caught.` : 'Every step that may not be omitted fired on its probe case.', { measurement_value: probes.length - missing.length, measurement_unit: 'steps', comparison_operator: '>=', threshold: probes.length, samples: probes.length, minimum_samples: probes.length }));

    const candOk = arms.candidate.error === null && c.errors === 0;
    gates.push(gateResult('minimum_samples', 'Enough scored cases', 'HARD_GATE', candOk && c.n >= pol.minimum_samples ? 'PASSED' : 'FAILED', candOk ? `${c.n} cases scored; at least ${pol.minimum_samples} are required.` : `The candidate did not produce an answer for every case (${arms.candidate.error ?? `${c.errors} missing`}).`, { measurement_value: c.n - c.errors, measurement_unit: 'cases', comparison_operator: '>=', threshold: pol.minimum_samples, samples: c.n, minimum_samples: pol.minimum_samples }));
    gates.push(gateResult('escaped_defects_not_worse', 'No more defects escape', 'HARD_GATE', c.escaped_defect_rate <= i.escaped_defect_rate + 1e-9 ? 'PASSED' : 'FAILED', `Share of breaking changes approved: candidate ${pct(c.escaped_defect_rate)}, incumbent ${pct(i.escaped_defect_rate)}.`, { measurement_value: round(c.escaped_defect_rate), measurement_unit: 'rate', comparison_operator: '<=', threshold: round(i.escaped_defect_rate), samples: c.n, minimum_samples: pol.minimum_samples }));
    gates.push(gateResult('false_alarms_within_margin', 'Safe changes are not blocked', 'HARD_GATE', c.false_alarm_rate <= i.false_alarm_rate + pol.false_alarm_margin + 1e-9 ? 'PASSED' : 'FAILED', `Share of safe changes blocked: candidate ${pct(c.false_alarm_rate)}, incumbent ${pct(i.false_alarm_rate)}; allowed margin ${pct(pol.false_alarm_margin)}.`, { measurement_value: round(c.false_alarm_rate), measurement_unit: 'rate', comparison_operator: '<=', threshold: round(i.false_alarm_rate + pol.false_alarm_margin), samples: c.n, minimum_samples: pol.minimum_samples }));
    gates.push(gateResult('no_regression_vs_baseline', 'No cumulative regression against the original baseline', 'HARD_GATE', c.accuracy >= b.accuracy - pol.non_inferiority_margin - 1e-9 ? 'PASSED' : 'FAILED', `Accuracy: candidate ${pct(c.accuracy)}, original baseline ${pct(b.accuracy)}.`, { measurement_value: round(c.accuracy), measurement_unit: 'accuracy', comparison_operator: '>=', threshold: round(b.accuracy - pol.non_inferiority_margin), samples: c.n, minimum_samples: pol.minimum_samples }));
    gates.push(gateResult('cost_within_bound', 'Cost stays within bound', 'HARD_GATE', c.steps <= Math.max(1, i.steps) * pol.max_cost_ratio ? 'PASSED' : 'FAILED', `Steps per review: candidate ${c.steps}, incumbent ${i.steps}; at most ${pol.max_cost_ratio}× is allowed.`, { measurement_value: c.steps, measurement_unit: 'steps', comparison_operator: '<=', threshold: Math.max(1, i.steps) * pol.max_cost_ratio }));

    // The resampling seed comes from what is being judged, so repeating the evaluation repeats the numbers.
    const seed = seedFrom(`${cand.candidate_hash}:${set}`);
    const paired = (metric: string, unit: string, higher: boolean, pick: (s: CaseScore) => number, cv: number, iv: number, bv: number): MetricComparison => {
      const dI = scored.candidate.scores.map((s, k) => pick(s) - pick(scored.incumbent.scores[k]!));
      const dB = scored.candidate.scores.map((s, k) => pick(s) - pick(scored.baseline.scores[k]!));
      const ci = pairedBootstrapCI(dI, { seed, iterations: RESAMPLES });
      const cb = pairedBootstrapCI(dB, { seed: seed + 1, iterations: RESAMPLES });
      const st = signTest(dI);
      return { metric, unit, higher_is_better: higher, candidate: round(cv), incumbent: round(iv), baseline: round(bv), diff_vs_incumbent: round(ci.mean), ci95_vs_incumbent: [round(ci.lo)!, round(ci.hi)!], diff_vs_baseline: round(cb.mean), ci95_vs_baseline: [round(cb.lo)!, round(cb.hi)!], n: cases.length, method: `paired bootstrap over the same ${cases.length} cases (${RESAMPLES} resamples, seeded); sign test: ${st.wins} better, ${st.losses} worse, ${st.ties} same, p=${round(st.p, 5)}` };
    };
    const primary = paired('accuracy', 'share of reviews with the right verdict and the affected field named', true, (s) => (s.correct ? 1 : 0), c.accuracy, i.accuracy, b.accuracy);
    const harm = paired('harm_per_review', 'severity-weighted cost of wrong verdicts', false, (s) => s.harm, c.harm_per_case, i.harm_per_case, b.harm_per_case);
    const steps: MetricComparison = { metric: 'steps_per_review', unit: 'validator steps (counted by the gate)', higher_is_better: false, candidate: c.steps, incumbent: i.steps, baseline: b.steps, diff_vs_incumbent: c.steps - i.steps, ci95_vs_incumbent: [c.steps - i.steps, c.steps - i.steps], diff_vs_baseline: c.steps - b.steps, ci95_vs_baseline: [c.steps - b.steps, c.steps - b.steps], n: cases.length, method: 'exact count; no sampling' };
    const wall: MetricComparison = { metric: 'wall_ms_per_review', unit: 'milliseconds, measured outside the candidate process', higher_is_better: false, candidate: round(c.wall_ms_per_case, 3), incumbent: round(i.wall_ms_per_case, 3), baseline: round(b.wall_ms_per_case, 3), diff_vs_incumbent: round(c.wall_ms_per_case - i.wall_ms_per_case, 3), ci95_vs_incumbent: null, diff_vs_baseline: round(c.wall_ms_per_case - b.wall_ms_per_case, 3), ci95_vs_baseline: null, n: cases.length, method: 'single timing of the whole batch; indicative only' };
    const rate = (metric: string, unit: string, cv: number, iv: number, bv: number): MetricComparison => ({ metric, unit, higher_is_better: false, candidate: round(cv), incumbent: round(iv), baseline: round(bv), diff_vs_incumbent: round(cv - iv), ci95_vs_incumbent: null, diff_vs_baseline: round(cv - bv), ci95_vs_baseline: null, n: cases.length, method: 'observed rate on the held-out set' });

    gates.push(gateResult('accuracy_gain', 'Review accuracy', 'WEIGHTED', primary.diff_vs_incumbent! > 0 ? 'PASSED' : 'FAILED', `Accuracy changed by ${primary.diff_vs_incumbent} (95% interval ${primary.ci95_vs_incumbent![0]} to ${primary.ci95_vs_incumbent![1]}).`, { measurement_value: primary.diff_vs_incumbent, measurement_unit: 'accuracy difference', comparison_operator: '>', threshold: 0, weight: 0.6, samples: cases.length, minimum_samples: pol.minimum_samples }));
    gates.push(gateResult('harm_reduction', 'Severity-weighted harm', 'WEIGHTED', harm.diff_vs_incumbent! < 0 ? 'PASSED' : 'FAILED', `Harm per review changed by ${harm.diff_vs_incumbent}.`, { measurement_value: harm.diff_vs_incumbent, measurement_unit: 'harm difference', comparison_operator: '<', threshold: 0, weight: 0.25, samples: cases.length, minimum_samples: pol.minimum_samples }));
    gates.push(gateResult('cost', 'Cost per review', 'WEIGHTED', c.steps <= i.steps ? 'PASSED' : 'FAILED', `Steps per review changed by ${c.steps - i.steps}.`, { measurement_value: c.steps - i.steps, measurement_unit: 'steps', comparison_operator: '<=', threshold: 0, weight: 0.15 }));

    const known_regressions: string[] = [];
    for (const [cls, v] of Object.entries(c.by_class)) {
      const inc = i.by_class[cls];
      if (inc && v.correct < inc.correct) known_regressions.push(`${cls}: ${v.correct}/${v.n} correct, down from ${inc.correct}/${inc.n} under the incumbent`);
    }
    if (c.steps > i.steps) known_regressions.push(`Each review runs ${c.steps - i.steps} more step(s)`);
    return {
      comparisons: [primary, harm, rate('escaped_defect_rate', 'share of breaking changes approved', c.escaped_defect_rate, i.escaped_defect_rate, b.escaped_defect_rate), rate('false_alarm_rate', 'share of safe changes blocked', c.false_alarm_rate, i.false_alarm_rate, b.false_alarm_rate), steps, wall],
      gates,
      primary,
      cost: steps,
      known_regressions,
      limitations,
      units: cases.length * 3 + probes.length,
      snapshot: { set, cases: cases.length, arms: { baseline: b, incumbent: i, candidate: c }, screening, candidate_reported: arms.candidate.advisories, forced_despite_screening: Boolean(screening.length && opts.force_execute_despite_screening) },
      executor: 'validator-executor',
      deterministic: true,
      cases: cases.length,
    };
  }

  /** Evaluators for the other levels register themselves here (see `src/evolution/arena.ts`). */
  evaluators: Partial<Record<ComponentLevel, (gate: Gate, exp: Experiment) => Promise<LevelEvaluation>>> = {};

  /**
   * Steps 8–9: evaluate against the incumbent and the fixed original baseline, then accept,
   * reject, or report the evidence as inconclusive. The receipt is written whatever the outcome.
   */
  async evaluate(experiment_id: string, opts: { force_execute_despite_screening?: boolean } = {}): Promise<ImprovementReceipt> {
    const exp = this.experiments.must(experiment_id);
    if (!exp.candidate || !exp.protocol) throw new SwarmError('not_ready', `Experiment ${experiment_id} has no submitted candidate`);
    if (exp.decision) throw new SwarmError('already_decided', `Experiment ${experiment_id} was already decided (${exp.decision}); a revision is a new experiment with fresh held-out cases`);
    const t0 = Date.now();
    const before = this.protectedDigest();
    const sealed = this.meta<string>('sealed_digest') ?? before;
    // The candidate in custody must still be the bytes that were submitted.
    const custody = hashDir(exp.candidate.ingested_dir) === exp.candidate.candidate_hash;

    let ev: LevelEvaluation;
    if (exp.level === 'execution') ev = await this.evaluateExecution(exp, opts);
    else if (this.evaluators[exp.level]) ev = await this.evaluators[exp.level]!(this, exp);
    else ev = { comparisons: [], gates: [gateResult('evaluator_available', 'An evaluator exists for this level', 'HARD_GATE', 'REMAINING', `No evaluator is installed for ${exp.level}-level candidates in this build.`)], primary: null, cost: null, known_regressions: [], limitations: ['Not evaluated.'], units: 0, snapshot: {}, executor: 'none', deterministic: true, cases: 0 };

    const after = this.protectedDigest();
    const intact = before === after && after === sealed && custody && this.verifyLedger().ok;
    ev.gates.unshift(gateResult('protected_integrity', 'Rules and records are intact', 'HARD_GATE', intact ? 'PASSED' : 'FAILED', intact ? 'The protected rules, held-out cases and records are byte-identical to the sealed state, before and after the evaluation.' : 'The protected store or the candidate in custody changed. No decision can rest on this evaluation.'));

    const failed = ev.gates.filter((g) => g.kind === 'HARD_GATE' && g.verdict === 'FAILED');
    const remaining = ev.gates.filter((g) => g.kind === 'HARD_GATE' && g.verdict === 'REMAINING');
    const margin = this.policy().levels[exp.level].non_inferiority_margin;
    let decision: ExperimentDecision;
    let justification: string;
    const ci = ev.primary?.ci95_vs_incumbent ?? null;
    if (failed.length) {
      // Hard gates are non-compensable: no score, saving or speed-up outweighs one.
      decision = 'reject';
      justification = `Rejected: ${failed.map((g) => g.name.toLowerCase()).join('; ')} failed. ${failed[0]!.meaning}`;
    } else if (remaining.length || !ci || !ev.primary) {
      decision = 'inconclusive';
      justification = `No demonstrated improvement: ${remaining.map((g) => g.meaning).join(' ') || 'the primary comparison could not be made.'}`;
    } else if (exp.declared_simplification) {
      const cheaper = (ev.cost?.diff_vs_incumbent ?? 0) < 0;
      if (ci[0] >= -margin && cheaper) {
        decision = 'accept';
        justification = `Accepted as a simplification: ${ev.primary.metric} is non-inferior (95% interval ${ci[0]} to ${ci[1]}, margin ${margin}) and cost falls by ${Math.abs(ev.cost!.diff_vs_incumbent!)} ${ev.cost!.unit}.`;
      } else if (ci[1] < -margin) {
        decision = 'reject';
        justification = `Rejected: the simplification makes ${ev.primary.metric} worse (95% interval ${ci[0]} to ${ci[1]}).`;
      } else {
        decision = 'inconclusive';
        // Two different reasons, stated separately: quality may be unproven, or quality held and nothing was saved.
        justification = ci[0] >= -margin
          ? `No demonstrated improvement: ${ev.primary.metric} is no worse (95% interval ${ci[0]} to ${ci[1]}, margin ${margin}), but cost did not fall (${ev.cost ? `${ev.cost.metric} changed by ${ev.cost.diff_vs_incumbent}` : 'cost was not measured'}), so the simplification saves nothing.`
          : `No demonstrated improvement: non-inferiority within ${margin} was not shown (95% interval ${ci[0]} to ${ci[1]})${cheaper ? '' : ' and cost did not fall'}.`;
      }
    } else if (ci[0] > 0) {
      decision = 'accept';
      justification = `Accepted: ${ev.primary.metric} improved by ${ev.primary.diff_vs_incumbent} against the incumbent (95% interval ${ci[0]} to ${ci[1]}) with every hard gate passed.`;
    } else if (ci[1] < 0) {
      decision = 'reject';
      justification = `Rejected: ${ev.primary.metric} is worse than the incumbent (95% interval ${ci[0]} to ${ci[1]}).`;
    } else {
      decision = 'inconclusive';
      justification = `No demonstrated improvement: the 95% interval of the difference in ${ev.primary.metric} (${ci[0]} to ${ci[1]}) includes zero.`;
    }

    // Per-case records stay inside the protected store; the receipt carries aggregates only.
    const snapshotPath = join(this.rt.paths.protected, 'evaluations', `${exp.id}.json`);
    writeFileSync(snapshotPath, JSON.stringify({ experiment_id: exp.id, decided_at: this.clock.iso(), snapshot: ev.snapshot, gates: ev.gates, comparisons: ev.comparisons }, null, 2));
    const evaluation_snapshot_hash = sha256(readFileSync(snapshotPath));
    const ledger = this.ledger(exp.id);
    const isolation: IsolationReport = { mode: this.iso.mode, uid_separation: this.iso.uid_separation, candidate_uid: this.iso.candidate_uid, node_permission_model: this.iso.node_permission_model, protected_digest_before: before, protected_digest_after: after, intact, notes: [...this.iso.notes, ...(((ev.snapshot as { candidate_reported?: string[] }).candidate_reported ?? []).map((m) => `candidate reported: ${m}`))] };

    let release_manifest: ReleaseManifest | null = null;
    if (decision === 'accept') {
      const { registry } = this.rt;
      const incumbent = registry.manifest(exp.incumbent_release);
      const added = registry.addComponent(exp.level, exp.candidate.ingested_dir);
      release_manifest = registry.writeRelease({
        release_id: registry.nextReleaseId(),
        parent_release_id: incumbent.release_id,
        components: { ...incumbent.components, [exp.level]: added },
        policy_hash: exp.protocol.policy_hash,
        evaluation_snapshot_hash,
        receipt_id: null,
        rollback_target: incumbent.release_id,
        // Qualified, not yet in use: it becomes active only by surviving a bounded canary.
        status: 'canary',
        evidence_basis: exp.source === 'live' ? 'live' : exp.level === 'evolution' ? 'simulation' : 'fixture',
        created_at: this.clock.iso(),
      });
    }
    const receipt_id = newId('rcpt');
    const body: Omit<ImprovementReceipt, 'receipt_hash'> = {
      receipt_id,
      experiment_id: exp.id,
      level: exp.level,
      problem: exp.problem,
      hypothesis: exp.hypothesis,
      expected_benefit: exp.expected_benefit,
      possible_regressions: exp.possible_regressions,
      parent: exp.parent,
      change: { summary: exp.candidate.summary, files: exp.candidate.files, candidate_hash: exp.candidate.candidate_hash },
      evaluation: { protocol_id: exp.protocol.protocol_id, policy_hash: exp.protocol.policy_hash, frozen_at: exp.protocol.frozen_at, workload_refs: [`${exp.protocol.workload}:${exp.protocol.holdout_set ?? 'none'}`, `snapshot:${evaluation_snapshot_hash}`], holdout_set: exp.protocol.holdout_set ?? 'none available', executor: ev.executor, execution_kind: 'rerun', repeats: 1, deterministic: ev.deterministic, source: exp.source === 'live' ? 'live' : exp.level === 'evolution' ? 'simulation' : 'fixture' },
      attempts: [
        ...ledger.filter((l) => l.kind === 'development_attempt').map((l, k) => ({ attempt_no: k + 1, kind: 'development' as const, at: l.at, cases: Number(l.payload.cases ?? 0), note: String(l.payload.note ?? '') })),
        { attempt_no: ledger.filter((l) => l.kind === 'development_attempt').length + 1, kind: 'holdout' as const, at: this.clock.iso(), cases: ev.cases, note: ev.cases ? `one evaluation on ${exp.protocol.holdout_set}` : 'candidate was not executed on held-out cases' },
      ],
      resource_use: { experiment_units: ev.units + ledger.filter((l) => l.kind === 'development_attempt').reduce((a, l) => a + Number(l.payload.cases ?? 0), 0), wall_ms: Date.now() - t0, model_calls: 0, cost_usd_est: null },
      comparisons: ev.comparisons,
      gates: ev.gates,
      known_regressions: ev.known_regressions,
      limitations: ev.limitations,
      decision,
      justification,
      decided_by: 'release-gate',
      decided_at: this.clock.iso(),
      release_manifest,
      rollback_target: release_manifest?.rollback_target ?? null,
      isolation,
      evidence_basis: exp.source === 'live' ? 'live' : exp.level === 'evolution' ? 'simulation' : 'fixture',
    };
    const receipt: ImprovementReceipt = { ...body, receipt_hash: hashOf(body) };
    if (release_manifest) {
      release_manifest = this.rt.registry.writeRelease({ ...release_manifest, receipt_id });
      receipt.release_manifest = release_manifest;
    }
    this.receipts.put({ ...receipt, id: receipt_id });
    this.experiments.put({ ...exp, stage: 'decided', decision, receipt_id, release_id: release_manifest?.release_id ?? null, updated_at: this.clock.iso() });
    this.append(exp.id, 'holdout_evaluation', { set: exp.protocol.holdout_set, cases: ev.cases, units: ev.units, evaluation_snapshot_hash, intact });
    this.append(exp.id, 'decision', { decision, justification, receipt_id, receipt_hash: receipt.receipt_hash, policy_hash: exp.protocol.policy_hash, evaluation_snapshot_hash, release_id: release_manifest?.release_id ?? null });
    this.mirror('experiment_decided', { experiment_id: exp.id, level: exp.level, decision, receipt_id, release_id: release_manifest?.release_id ?? null, justification });
    return receipt;
  }

  receipt(id: string): ImprovementReceipt {
    return this.receipts.must(id);
  }

  // ───────────────────────────── canary, retain, rollback ─────────────────────────────

  /** Step 10: a qualified release is used only by a bounded number of development missions. */
  startCanary(release_id: string, scope: Partial<CanaryRecord['scope']> = {}): CanaryRecord {
    const m = this.rt.registry.manifest(release_id);
    if (m.status !== 'canary') throw new SwarmError('not_qualified', `Release ${release_id} is ${m.status}; only a release the gate accepted can enter a canary`);
    if (this.canaries.first(`"status" = 'running'`)) throw new SwarmError('canary_in_progress', 'Another canary is running');
    // A release is qualified against one parent. If a different release has become active since,
    // promoting this one would silently drop that release's changes.
    const active = this.rt.registry.active();
    if (m.parent_release_id && m.parent_release_id !== active) {
      this.append(this.experiments.first('"release_id" = ?', release_id)?.id ?? null, 'canary_refused_stale_parent', { release_id, qualified_against: m.parent_release_id, active });
      throw new SwarmError('stale_parent', `Release ${release_id} was qualified against ${m.parent_release_id}, but ${active} is now active. Rebuild the candidate on ${active} and evaluate it again.`, { release_id, qualified_against: m.parent_release_id, active });
    }
    const c: CanaryRecord = { id: newId('can'), release_id, prior_release_id: m.rollback_target ?? this.rt.registry.active(), scope: { max_missions: scope.max_missions ?? this.policy().canary.max_missions, data_class: 'synthetic', scenario: scope.scenario ?? null }, status: 'running', missions: [], observations: [], started_at: this.clock.iso(), ended_at: null, reason: null };
    this.canaries.put(c);
    const exp = this.experiments.first('"release_id" = ?', release_id);
    if (exp) this.experiments.put({ ...exp, stage: 'canary', canary_id: c.id, updated_at: this.clock.iso() });
    this.append(exp?.id ?? null, 'canary_started', { canary_id: c.id, release_id, prior_release_id: c.prior_release_id, scope: c.scope });
    this.mirror('canary_started', { canary_id: c.id, release_id, scope: c.scope });
    return c;
  }

  /**
   * Which release a new mission is pinned to: the canary release while a canary has room for a
   * matching development mission, otherwise the active release. Missions already running keep theirs.
   */
  releaseFor(m: { data_class?: string; scenario?: string | null; provider_mode?: string }): { release_id: string; canary_id: string | null } {
    const c = this.canaries.first(`"status" = 'running'`);
    const dataClass = m.data_class ?? 'synthetic';
    if (c && dataClass === c.scope.data_class && (c.scope.scenario === null || c.scope.scenario === (m.scenario ?? null)) && c.missions.length < c.scope.max_missions) return { release_id: c.release_id, canary_id: c.id };
    return { release_id: this.rt.registry.active(), canary_id: null };
  }

  noteCanaryMission(canary_id: string, mission_id: string): void {
    const c = this.canaries.must(canary_id);
    if (!c.missions.includes(mission_id)) this.canaries.put({ ...c, missions: [...c.missions, mission_id] });
  }

  /**
   * Step 11: monitor. Fresh cases nobody has evaluated on are scored for the canary release and
   * compared with what it scored when it was approved; canary missions are checked for acceptance
   * failures. A breach rolls the release back.
   */
  async observeCanary(canary_id: string, opts: { inject_regression?: { class: 'unit_annotation_added'; weight: number } } = {}): Promise<CanaryRecord> {
    let c = this.canaries.must(canary_id);
    if (c.status !== 'running') return c;
    const pol = this.policy();
    const exp = this.experiments.first('"release_id" = ?', c.release_id);
    const at = this.clock.iso();
    const observations: CanaryRecord['observations'] = [];
    if (exp?.level === 'execution') {
      const skill_id = Object.keys(pol.levels.execution.required_steps)[0]!;
      const fresh = freshCases(`${c.id}-${c.observations.length}`, pol.canary.fresh_cases, opts.inject_regression ?? null);
      const dir = this.rt.registry.componentDir('execution', this.rt.registry.manifest(c.release_id).components.execution.version);
      const now = await this.scoreBundle(dir, skill_id, fresh);
      const approved = (JSON.parse(readFileSync(join(this.rt.paths.protected, 'evaluations', `${exp.id}.json`), 'utf8')) as { snapshot: { arms: { candidate: ArmMetrics } } }).snapshot.arms.candidate;
      const drop = approved.accuracy - now.metrics.accuracy;
      const escapedUp = now.metrics.escaped_defect_rate - approved.escaped_defect_rate;
      observations.push({ at, metric: 'accuracy_drop_vs_approval', value: round(drop), threshold: pol.canary.rollback_if.accuracy_drop_gt, breached: drop > pol.canary.rollback_if.accuracy_drop_gt, injected: Boolean(opts.inject_regression) });
      observations.push({ at, metric: 'escaped_defect_rate_increase', value: round(escapedUp), threshold: pol.canary.rollback_if.escaped_defect_rate_increase_gt, breached: escapedUp > pol.canary.rollback_if.escaped_defect_rate_increase_gt, injected: Boolean(opts.inject_regression) });
    }
    if (exp?.level === 'evolution') {
      // An improvement-policy release is tried by letting it decide the organization's improvement
      // work within a bounded budget. It is rolled back if it asks for steps the runtime must refuse.
      const steps = (this.rt.store.getMeta<{ steps: { policy: { canary_id: string | null }; outcome: string }[] }>('evolution:portfolio')?.steps ?? []).filter((s) => s.policy.canary_id === c.id);
      const refused = steps.filter((s) => s.outcome.startsWith('refused')).length;
      const limit = pol.canary.rollback_if.policy_refused_actions_gt ?? 0;
      observations.push({ at, metric: 'decisions_made_under_canary', value: steps.length, threshold: 1, breached: false, injected: false });
      observations.push({ at, metric: 'policy_actions_refused', value: refused, threshold: limit, breached: refused > limit, injected: false });
    }
    const failures = c.missions.filter((id) => this.rt.store.observations.where('"mission_id" = ?', id).some((o) => o.kind === 'acceptance_failure' || o.kind === 'escaped_defect')).length;
    observations.push({ at, metric: 'canary_missions_with_acceptance_failures', value: c.missions.length ? failures : null, threshold: pol.canary.rollback_if.acceptance_failures_gt, breached: failures > pol.canary.rollback_if.acceptance_failures_gt, injected: false });
    c = { ...c, observations: [...c.observations, ...observations] };
    this.canaries.put(c);
    this.append(exp?.id ?? null, 'canary_observation', { canary_id, observations, injected_regression: opts.inject_regression ?? null });
    this.mirror('canary_observed', { canary_id, release_id: c.release_id, breached: observations.filter((o) => o.breached).map((o) => o.metric), injected: Boolean(opts.inject_regression) });
    if (observations.some((o) => o.breached)) return this.rollback(canary_id, `canary breach: ${observations.filter((o) => o.breached).map((o) => `${o.metric}=${o.value} (limit ${o.threshold})`).join(', ')}`);
    return c;
  }

  /** Retain: the canary release becomes the default for future missions. Running missions keep their release. */
  retain(canary_id: string): CanaryRecord {
    const c = this.canaries.must(canary_id);
    if (c.status !== 'running') throw new SwarmError('canary_closed', `Canary ${canary_id} is ${c.status}`);
    if (c.observations.length === 0) throw new SwarmError('not_observed', 'A canary cannot be retained before it has been observed');
    const decided = c.observations.filter((o) => o.metric === 'decisions_made_under_canary').at(-1);
    if (decided && Number(decided.value ?? 0) < 1) throw new SwarmError('not_observed', 'This release changes the improvement policy, and the policy has not made a decision under the canary yet');
    const { registry } = this.rt;
    registry.setStatus(c.release_id, 'active');
    registry.setStatus(c.prior_release_id, 'retired');
    registry.setActive(c.release_id);
    const next: CanaryRecord = { ...c, status: 'retained', ended_at: this.clock.iso(), reason: 'no breach observed' };
    this.canaries.put(next);
    const exp = this.experiments.first('"release_id" = ?', c.release_id);
    if (exp) this.experiments.put({ ...exp, stage: 'retained', updated_at: this.clock.iso() });
    this.append(exp?.id ?? null, 'canary_retained', { canary_id, release_id: c.release_id, prior_release_id: c.prior_release_id, missions: c.missions });
    this.mirror('release_activated', { release_id: c.release_id, prior_release_id: c.prior_release_id, canary_id });
    return next;
  }

  /** Everything that depends on a release: missions pinned to it, artifacts produced under it, memories derived from it. */
  dependents(release_id: string): { missions: { id: string; title: string; status: string; in_flight: boolean }[]; artifacts: { key: string; version_no: number; mission_id: string; currency: string }[]; memories: { id: string; kind: string; statement: string; status: string }[] } {
    const { store } = this.rt;
    return {
      missions: store.missions.where('"release_id" = ?', release_id).map((m) => ({ id: m.id, title: m.title, status: m.status, in_flight: ['planning', 'active', 'blocked'].includes(m.status) })),
      artifacts: store.versions.where('"release_id" = ?', release_id).filter((v) => !v.key.startsWith('evidence/')).map((v) => ({ key: v.key, version_no: v.version_no, mission_id: v.mission_id, currency: v.currency })),
      memories: store.memories.where('1=1').filter((m) => m.provenance.release_id === release_id).map((m) => ({ id: m.id, kind: m.kind, statement: m.statement, status: m.status })),
    };
  }

  /**
   * Restore the prior release. Nothing that depended on the rolled-back version is silently kept:
   * in-flight missions are flagged for a deliberate migration decision, artifacts are marked for
   * revalidation, and memories derived under it are invalidated.
   */
  rollback(canary_id: string, reason: string): CanaryRecord {
    const c = this.canaries.must(canary_id);
    if (c.status !== 'running') throw new SwarmError('canary_closed', `Canary ${canary_id} is ${c.status}`);
    const { registry, store, comms } = this.rt;
    const deps = this.dependents(c.release_id);
    registry.setStatus(c.release_id, 'rolled_back');
    if (registry.active() === c.release_id) registry.setActive(c.prior_release_id);
    store.db.tx(() => {
      for (const d of deps.missions) {
        const m = store.missions.must(d.id);
        store.missions.put({ ...m, migration: { required: d.in_flight, reason: `release ${c.release_id} was rolled back: ${reason}`, from_release: c.release_id }, updated_at: store.clock.iso(), revision: m.revision + 1 });
        if (d.in_flight) {
          comms.openDecision({ mission_id: m.id, kind: 'migration', question: `Mission "${m.title}" is running on release ${c.release_id}, which was rolled back. How should it continue?`, owner_id: 'chief_of_staff', owner_kind: 'chief_of_staff', requires_human: true, options: [
            { id: 'repin_and_redo', label: `Move it to ${c.prior_release_id} and redo affected work`, evidence_ids: [], consequences: ['Work done under the rolled-back release is redone'], proposed_by: 'release-gate' },
            { id: 'finish_quarantined', label: 'Let it finish; treat its results as needing revalidation', evidence_ids: [], consequences: ['Its artifacts stay marked until revalidated'], proposed_by: 'release-gate' },
          ] });
        }
      }
      for (const v of store.versions.where('"release_id" = ? AND "currency" = ?', c.release_id, 'current')) store.versions.put({ ...v, currency: 'needs_revalidation' });
      for (const mem of store.memories.where(`"status" = 'active'`)) if (mem.provenance.release_id === c.release_id) store.memories.put({ ...mem, status: 'invalidated', invalidated_by: `rollback of ${c.release_id}` });
    });
    const next: CanaryRecord = { ...c, status: 'rolled_back', ended_at: this.clock.iso(), reason };
    this.canaries.put(next);
    const exp = this.experiments.first('"release_id" = ?', c.release_id);
    if (exp) this.experiments.put({ ...exp, stage: 'rolled_back', updated_at: this.clock.iso() });
    this.append(exp?.id ?? null, 'rollback', { canary_id, release_id: c.release_id, restored: c.prior_release_id, reason, dependents: { missions: deps.missions.length, artifacts: deps.artifacts.length, memories: deps.memories.length } });
    this.mirror('release_rolled_back', { release_id: c.release_id, restored: c.prior_release_id, reason, missions: deps.missions.map((m) => m.id), artifacts: deps.artifacts.length, memories: deps.memories.length });
    return next;
  }

  // ───────────────────────────── changes to the rules themselves ─────────────────────────────

  /**
   * Anyone may propose a better rule, test or scoring method. The proposal is recorded and routed
   * to the chief of staff as a decision that needs a person. The gate never applies it.
   */
  proposeRuleChange(input: { proposed_by: string; summary: string; rationale: string; experiment_id?: string | null }): { decision_id: string; applied: false } {
    const d = this.rt.comms.openDecision({ mission_id: null, kind: 'rule_change', question: `Proposed change to the protected promotion rules: ${input.summary}`, owner_id: 'chief_of_staff', owner_kind: 'chief_of_staff', requires_human: true, options: [
      { id: 'approve', label: 'Approve; an operator applies it and reseals the protected store', evidence_ids: [], consequences: ['Future experiments are judged under the new rules', 'Experiments already frozen keep the rules they were frozen under'], proposed_by: input.proposed_by },
      { id: 'decline', label: 'Decline', evidence_ids: [], consequences: ['The rules stay as they are'], proposed_by: input.proposed_by },
    ] });
    this.append(input.experiment_id ?? null, 'rule_change_proposed', { ...input, decision_id: d.id, applied: false });
    this.mirror('rule_change_proposed', { decision_id: d.id, proposed_by: input.proposed_by, summary: input.summary });
    return { decision_id: d.id, applied: false };
  }

  /** After an approved rule change has been applied by an operator, record the new sealed state. */
  reseal(actor: string, decision_id: string): { sealed: Sha256 } {
    const d = this.rt.store.decisions.must(decision_id);
    if (d.kind !== 'rule_change' || d.status !== 'resolved' || d.chosen !== 'approve') throw new SwarmError('not_authorized', 'The protected store can only be resealed after the chief of staff approves a rule change');
    const digest = this.protectedDigest();
    this.setMeta('sealed_digest', digest);
    this.append(null, 'protected_store_resealed', { actor, decision_id, digest, policy_hash: this.policyHash() });
    return { sealed: digest };
  }

  close(): void {
    this.db.close();
  }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function specOf(dir: string): CandidateSpec {
  return JSON.parse(readFileSync(join(dir, 'candidate.json'), 'utf8')) as CandidateSpec;
}

export { existsSync };
