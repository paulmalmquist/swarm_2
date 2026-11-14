import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../config.ts';
import type { GateResult, MetricComparison } from '../contracts/types.ts';
import { Coordinator, type FaultSpec } from '../coordination/coordinator.ts';
import { LocalChiefOfStaff, type RawRequest } from '../cos/port.ts';
import { type Experiment, type Gate, type LevelEvaluation, RESAMPLES, gateResult } from '../gate/gate.ts';
import { LEVELS } from '../gate/registry.ts';
import { pairedBootstrapCI, round, signTest } from '../lib/stats.ts';
import { rng, seedFrom } from '../lib/util.ts';
import { openRuntime } from '../runtime.ts';
import { parseTap } from '../workspace/workspaces.ts';
import { readFileSync } from 'node:fs';
import { episodeSeeds } from '../../protected/cases/arena-holdout.ts';

/**
 * MISSION EPISODES — the testbed for coordination-level candidates.
 *
 * Each episode runs one complete fixture mission (real runtime, real worker processes, real
 * merges and tests) under a given coordination policy, in its own state directory. Afterwards an
 * oracle — the protected acceptance suite — is run on whatever the mission accepted, which shows
 * how many defects escaped.
 *
 * What is synthetic: the mission, its workers, and the rate at which defects are injected into
 * a worker's first attempt (a property of this testbed, not a measurement of real work).
 */

export interface EpisodeResult {
  seed: string;
  injected: string | null;
  completed: boolean;
  /** Every acceptance criterion holds on the accepted result, according to the oracle. */
  truly_correct: boolean;
  escaped_defects: number;
  worker_invocations: number;
  elapsed_ms: number;
  rework: number;
  tasks: number;
  swarms: number;
  messages: number;
}

const DEFECTS: FaultSpec[] = [
  { task_key: 'delivery.engine.implement', attempt: 1, fault: 'defect:ignores_policy_default' },
  { task_key: 'delivery.report.implement', attempt: 1, fault: 'defect:unknown_as_zero' },
];

function requests(): RawRequest[] {
  return (JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures/scenarios/shared-capability/requests.json'), 'utf8')) as { requests: RawRequest[] }).requests;
}

/** Run one mission under the coordination definitions in `coordinationDir`, then ask the oracle. */
export async function runEpisode(coordinationDir: string, seed: string, opts: { defect_rate: number }): Promise<EpisodeResult> {
  const home = mkdtempSync(join(tmpdir(), 'swarm2-episode-'));
  const rt = openRuntime({ home });
  const co = new Coordinator(rt);
  try {
    // A registry for this episode only: the baseline definitions with the coordination level swapped.
    const defs = join(home, 'definitions');
    for (const level of LEVELS) cpSync(level === 'coordination' ? coordinationDir : join(REPO_ROOT, 'definitions', level, 'v1'), join(defs, level, 'v1'), { recursive: true });
    rt.registry.init(defs, 'episode', rt.store.clock.iso());
    const cos = new LocalChiefOfStaff(rt);
    const ing = cos.ingestRequests({ command: 'ingestRequests', actor: 'chief_of_staff', key: 'ep-ingest', data: { requests: requests() } });
    if (ing.source === 'unavailable') throw new Error(ing.reason);
    const sub = cos.submitMission({ command: 'submitMission', actor: 'chief_of_staff', key: 'ep-submit', data: { title: 'Shared dataset-health capability', objective: 'One policy-driven view of dataset health.', request_ids: ing.clusters[0]!.request_ids, scenario: 'shared-capability' } });
    if (sub.source === 'unavailable') throw new Error(sub.reason);
    const m = sub.mission;
    const r = rng(seedFrom(`episode:${seed}`));
    const injected = r() < opts.defect_rate ? DEFECTS[Math.floor(r() * DEFECTS.length)]! : null;
    if (injected) {
      rt.store.setMeta(`faults:${m.id}`, [injected]);
      rt.store.emit({ type: 'fault_plan_installed', mission_id: m.id, actor_id: 'episode-runner', actor_kind: 'operator', payload: { label: 'INJECTED DEFECT', faults: [injected] } });
    }
    const t0 = Date.now();
    const state = await co.runUntilIdle({ mission_id: m.id, max_ms: 120_000 });
    await co.drain();
    const elapsed_ms = Date.now() - t0;
    const completed = state === 'idle' && rt.store.missions.must(m.id).status === 'review_ready';

    // The oracle: the protected acceptance suite on whatever the mission accepted.
    let failing = -1;
    const integrated = rt.kernel.currentVersion(m.id, 'code/integrated');
    if (completed && integrated?.content_ref.startsWith('git:')) {
      const dir = rt.workspaces.checkoutForVerification(m.id, integrated.content_ref.slice(4), 'oracle');
      cpSync(join(REPO_ROOT, 'fixtures/scenarios/shared-capability/acceptance'), join(dir, 'acceptance'), { recursive: true });
      const run = await rt.workspaces.run(dir, ['node', '--disable-warning=ExperimentalWarning', '--test', 'acceptance/**/*.test.ts'], 90_000);
      const results = parseTap(run.stdout);
      failing = results.length ? results.filter((x) => !x.ok).length : -1;
    }
    const tasks = rt.store.tasks.where('"mission_id" = ?', m.id);
    return {
      seed,
      injected: injected ? injected.fault : null,
      completed,
      truly_correct: completed && failing === 0,
      escaped_defects: completed && failing > 0 ? failing : 0,
      worker_invocations: rt.kernel.budget.spent(m.budget_account_id).worker_invocations,
      elapsed_ms,
      rework: rt.store.observations.where('"mission_id" = ?', m.id).filter((o) => o.kind === 'rework').length,
      tasks: tasks.filter((t) => t.executor !== 'container').length,
      swarms: rt.store.swarms.count('"mission_id" = ?', m.id),
      messages: rt.store.messages.count('"mission_id" = ?', m.id),
    };
  } finally {
    co.stop();
    rt.close();
    rmSync(home, { recursive: true, force: true });
  }
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** Level 2 evaluation: a coordination policy against the incumbent on the same seeded mission episodes. */
export async function evaluateCoordination(gate: Gate, exp: Experiment): Promise<LevelEvaluation> {
  const pol = gate.policy().levels.coordination as unknown as { holdout_episodes: number; minimum_samples: number; defect_rate: number };
  const { registry } = gate.rt;
  const cand = exp.candidate!;
  const set = exp.protocol!.holdout_set;
  const gates: GateResult[] = [];
  const limitations = [
    'Each episode is a complete fixture mission: the runtime, worker processes, merges and tests are real, the work content is scripted.',
    `A defect is injected into one worker's first attempt in about ${Math.round(pol.defect_rate * 100)}% of episodes. That rate is an assumption of this testbed; the size of any effect depends on it.`,
    'The oracle is the same protected acceptance suite the verification swarm uses, so this measures what happens when nobody runs it — not whether it is a complete specification.',
    `${pol.holdout_episodes} episodes per arm: intervals are wide.`,
  ];
  const screening = gate.staticScreen(cand.ingested_dir);
  gates.push(gateResult('no_forbidden_capabilities', 'No forbidden capabilities', 'HARD_GATE', screening.length ? 'FAILED' : 'PASSED', screening.length ? screening.join('; ') : 'A coordination policy is data; the bundle contains no code that uses a forbidden capability.'));
  gates.push(gateResult('holdout_not_reused', 'Episodes are unseen by this lineage', 'HARD_GATE', set ? 'PASSED' : 'REMAINING', set ? `Run on episode set ${set}.` : 'No unused episode set is registered for this lineage.'));
  if (screening.length || !set) {
    for (const g of ['minimum_samples', 'missions_complete', 'escaped_defects_not_worse']) gates.push(gateResult(g, g.replace(/_/g, ' '), 'HARD_GATE', 'REMAINING', 'Not measured.'));
    return { comparisons: [], gates, primary: null, cost: null, known_regressions: [], limitations, units: 0, snapshot: { executed: false }, executor: 'mission-episodes', deterministic: false, cases: 0 };
  }
  gate.db.run('INSERT INTO holdout_usage (lineage_id, level, set_id, experiment_id, at) VALUES (?, ?, ?, ?, ?)', exp.lineage_id, 'coordination', set, exp.id, gate.rt.store.clock.iso());
  const seeds = episodeSeeds(set, pol.holdout_episodes);
  const incDir = registry.componentDir('coordination', registry.manifest(exp.incumbent_release).components.coordination.version);
  const incumbent: EpisodeResult[] = [];
  const candidate: EpisodeResult[] = [];
  for (const seed of seeds) {
    incumbent.push(await runEpisode(incDir, seed, pol));
    candidate.push(await runEpisode(cand.ingested_dir, seed, pol));
  }
  const incomplete = candidate.filter((e) => !e.completed).length + incumbent.filter((e) => !e.completed).length;
  const esc = (xs: EpisodeResult[]): number => xs.reduce((a, e) => a + e.escaped_defects, 0);
  gates.push(gateResult('minimum_samples', 'Enough episodes', 'HARD_GATE', candidate.length >= pol.minimum_samples ? 'PASSED' : 'FAILED', `${candidate.length} episodes per arm; at least ${pol.minimum_samples} are required.`, { measurement_value: candidate.length, measurement_unit: 'episodes', comparison_operator: '>=', threshold: pol.minimum_samples, samples: candidate.length, minimum_samples: pol.minimum_samples }));
  gates.push(gateResult('missions_complete', 'Every mission reaches review', 'HARD_GATE', incomplete === 0 ? 'PASSED' : 'FAILED', `${incomplete} missions did not reach a reviewable state.`, { measurement_value: incomplete, measurement_unit: 'missions', comparison_operator: '=', threshold: 0 }));
  gates.push(gateResult('escaped_defects_not_worse', 'No more defects escape', 'HARD_GATE', esc(candidate) <= esc(incumbent) ? 'PASSED' : 'FAILED', `Acceptance criteria that fail on results the mission accepted: candidate ${esc(candidate)}, incumbent ${esc(incumbent)}, across ${seeds.length} episodes.`, { measurement_value: esc(candidate), measurement_unit: 'escaped defects', comparison_operator: '<=', threshold: esc(incumbent), samples: seeds.length, minimum_samples: pol.minimum_samples }));

  const seed = seedFrom(`${cand.candidate_hash}:${set}`);
  const paired = (metric: string, unit: string, higher: boolean, pick: (e: EpisodeResult) => number, s: number): MetricComparison => {
    const d = candidate.map((e, k) => pick(e) - pick(incumbent[k]!));
    const ci = pairedBootstrapCI(d, { seed: s, iterations: RESAMPLES });
    const st = signTest(d);
    return { metric, unit, higher_is_better: higher, candidate: round(mean(candidate.map(pick))), incumbent: round(mean(incumbent.map(pick))), baseline: round(mean(incumbent.map(pick))), diff_vs_incumbent: round(ci.mean), ci95_vs_incumbent: [round(ci.lo)!, round(ci.hi)!], diff_vs_baseline: round(ci.mean), ci95_vs_baseline: [round(ci.lo)!, round(ci.hi)!], n: d.length, method: `paired bootstrap over the same ${d.length} mission episodes (${RESAMPLES} resamples, seeded); sign test: ${st.wins} better, ${st.losses} worse, ${st.ties} same, p=${round(st.p, 5)}` };
  };
  const primary = paired('truly_correct_missions', 'share of missions whose accepted result passes every acceptance criterion', true, (e) => (e.truly_correct ? 1 : 0), seed);
  const escaped = paired('escaped_defects_per_mission', 'acceptance criteria failing on an accepted result', false, (e) => e.escaped_defects, seed + 2);
  const invocations = paired('worker_invocations_per_mission', 'worker invocations', false, (e) => e.worker_invocations, seed + 4);
  const time = paired('completion_ms', 'milliseconds from start to a reviewable result', false, (e) => e.elapsed_ms, seed + 6);
  const rework = paired('rework_per_mission', 'times work was sent back', false, (e) => e.rework, seed + 8);
  gates.push(gateResult('correctness', 'Truly correct missions', 'WEIGHTED', primary.diff_vs_incumbent! >= 0 ? 'PASSED' : 'FAILED', `Share of missions that are truly correct changed by ${primary.diff_vs_incumbent}.`, { measurement_value: primary.diff_vs_incumbent, measurement_unit: 'share', comparison_operator: '>=', threshold: 0, weight: 0.7, samples: seeds.length, minimum_samples: pol.minimum_samples }));
  gates.push(gateResult('cost', 'Worker invocations per mission', 'WEIGHTED', invocations.diff_vs_incumbent! <= 0 ? 'PASSED' : 'FAILED', `Worker invocations per mission changed by ${invocations.diff_vs_incumbent}.`, { measurement_value: invocations.diff_vs_incumbent, measurement_unit: 'invocations', comparison_operator: '<=', threshold: 0, weight: 0.3, samples: seeds.length, minimum_samples: pol.minimum_samples }));
  const known_regressions: string[] = [];
  if (esc(candidate) > esc(incumbent)) known_regressions.push(`${esc(candidate) - esc(incumbent)} more defects reached an accepted result than under the incumbent`);
  return {
    comparisons: [primary, escaped, invocations, time, rework],
    gates,
    primary,
    cost: invocations,
    known_regressions,
    limitations,
    units: [...incumbent, ...candidate].reduce((a, e) => a + e.worker_invocations, 0),
    snapshot: { set, episodes: seeds.length, defect_rate: pol.defect_rate, incumbent, candidate, injected_episodes: incumbent.filter((e) => e.injected).length },
    executor: 'mission-episodes',
    // Worker scheduling is real, so timings vary from run to run even though outcomes do not.
    deterministic: false,
    cases: seeds.length,
  };
}
