import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installArena } from '../src/evolution/arena.ts';
import { observeReviewWork, runExperiment } from '../src/evolution/loop.ts';
import { portfolio, portfolioCampaign, recordReport } from '../src/evolution/portfolio.ts';
import { Gate } from '../src/gate/gate.ts';
import { openRuntime } from '../src/runtime.ts';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'swarm2-portfolio-'));
  const rt = openRuntime({ home });
  const gate = new Gate(rt);
  gate.init();
  installArena(gate);
  return { home, rt, gate, cleanup: () => { gate.close(); rt.close(); rmSync(home, { recursive: true, force: true }); } };
}

const BUDGET = 900;
const seed = async (s: ReturnType<typeof setup>): Promise<void> => {
  await observeReviewWork(s.rt, s.gate);
  // SYNTHETIC: a frequently repeated complaint that nobody has verified.
  recordReport(s.rt, { failure_class: 'style_nit', count: 30, note: 'SYNTHETIC complaint: optional field names are not snake_case' });
};

test('the active improvement policy decides the organization\'s improvement work; replacing it changes what is done', async () => {
  const control = setup();
  const trial = setup();
  try {
    // Control: the baseline release, whose policy works on whatever is reported most often.
    await seed(control);
    const before = portfolio(control.rt, control.gate);
    const nit = before.problems.find((p) => p.id === 'style_nit')!;
    assert.equal(nit.verified_count, 0);
    assert.equal(nit.observed_count, 30, 'unverified reports are counted as observations, never as verified failures');
    assert.ok(before.problems.some((p) => p.verified_count > 0));
    assert.equal(before.policy.evolution_version, 1);

    const a = await portfolioCampaign(control.rt, control.gate, { budget: BUDGET });
    assert.equal(a.steps[0]!.policy.id, 'frequency-first');
    assert.deepEqual([a.steps[0]!.action.type, a.steps[0]!.action.candidate_id], ['build', 'style_strict'], 'it starts with the loudest complaint');
    const nitHyp = a.view.hypotheses.find((h) => h.id === 'style_strict')!;
    assert.equal(nitHyp.status, 'inconclusive', 'the gate finds no demonstrated improvement from fixing a complaint that was never a defect');
    assert.ok(nitHyp.receipt_id && nitHyp.failed_approach_memory_id);
    const mem = control.rt.store.memories.must(nitHyp.failed_approach_memory_id!);
    assert.equal(mem.kind, 'failed_approach');
    assert.equal(mem.certainty, 'suspected', 'an inconclusive result is not recorded as a verified failure');
    assert.deepEqual(mem.provenance.evidence_ids, [nitHyp.receipt_id]);
    assert.ok(a.view.allocation.campaign_spent <= BUDGET, 'the campaign stays inside its budget');
    assert.equal(a.view.allocation.exploration.spent > 0, true);
    assert.equal(control.rt.store.events({ type: 'portfolio_step' }).length, a.steps.length, 'every decision is a persisted event');

    // Trial: the expected-value policy is qualified by the gate, then tried in a bounded canary.
    const evo = await runExperiment(trial.rt, trial.gate, 'evo-expected-value');
    assert.equal(evo.receipt.decision, 'accept');
    const release = evo.receipt.release_manifest!.release_id;
    const canary = trial.gate.startCanary(release, { max_missions: 0 });
    await assert.rejects(async () => { await trial.gate.observeCanary(canary.id); trial.gate.retain(canary.id); }, /has not made a decision/);
    await seed(trial);
    assert.equal(portfolio(trial.rt, trial.gate).policy.release_id, release, 'while the canary runs, its policy is in charge');
    assert.equal(trial.rt.registry.active(), 'r1', 'and the default has not changed');

    const b = await portfolioCampaign(trial.rt, trial.gate, { budget: BUDGET });
    assert.equal(b.steps[0]!.policy.id, 'expected-value');
    assert.equal(b.steps[0]!.policy.canary_id, canary.id);
    assert.ok(!b.steps.some((s) => s.action.candidate_id === 'style_strict'), 'it never spends on the unverified complaint');
    assert.ok(b.steps.some((s) => s.action.type === 'pilot'), 'it pilots on observed cases before paying for a held-out evaluation');
    assert.ok(b.steps.filter((s) => s.action.type === 'submit').every((s) => b.steps.some((p) => p.action.type === 'pilot' && p.action.candidate_id === s.action.candidate_id && p.n < s.n)), 'every submission was piloted first');
    assert.ok(b.view.allocation.campaign_spent <= BUDGET);
    assert.ok(b.view.hypotheses.filter((h) => h.status === 'accepted').length >= 1, 'it gets at least one fix through the gate');
    // No claim is made here about which policy is cheaper: one campaign each is a case study.

    const observed = await trial.gate.observeCanary(canary.id);
    assert.equal(observed.status, 'running');
    assert.equal(observed.observations.find((o) => o.metric === 'policy_actions_refused')!.value, 0);
    trial.gate.retain(canary.id);
    assert.equal(trial.rt.registry.active(), release);
    assert.equal(trial.gate.verifyLedger().ok, true);

    // A release qualified against the old default cannot be promoted over the new one.
    const stale = b.view.hypotheses.find((h) => h.status === 'accepted')!;
    assert.throws(() => trial.gate.startCanary(stale.release_id!), /qualified against r1/);
    // The environment changed, so every hypothesis is reopened to be rebuilt on the new release.
    const after = portfolio(trial.rt, trial.gate);
    assert.ok(after.hypotheses.every((h) => h.status === 'proposed' && !h.built));
    assert.equal(after.problems.filter((p) => p.verified_count > 0).length, 0, 'verified failures are counted under the release in force: observing comes first');
    const reopened = trial.rt.store.events({ type: 'hypothesis_reopened' });
    assert.ok(reopened.some((e) => e.payload.hypothesis === stale.id && e.payload.was === 'accepted'));
    assert.ok(trial.rt.store.events({ type: 'memory_reconsidered' }).length >= 1, 'a failed approach is reconsidered when the environment changes');
  } finally {
    control.cleanup();
    trial.cleanup();
  }
});
