import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gate, PROTECTED_SRC } from '../src/gate/gate.ts';
import { observeReviewWork, runExperiment } from '../src/evolution/loop.ts';
import { openRuntime } from '../src/runtime.ts';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'swarm2-gate-'));
  const rt = openRuntime({ home });
  const gate = new Gate(rt);
  gate.init();
  return { home, rt, gate, cleanup: () => { gate.close(); rt.close(); rmSync(home, { recursive: true, force: true }); } };
}

const brief = (r: Awaited<ReturnType<typeof runExperiment>>['receipt']) => ({ decision: r.decision, why: r.justification, gates: r.gates.filter((g) => g.verdict !== 'PASSED').map((g) => `${g.id}:${g.verdict}`), acc: r.comparisons.find((c) => c.metric === 'accuracy') });

test('first-order improvement: an observed failure becomes a candidate judged on held-out cases', async () => {
  const s = setup();
  try {
    const seen = await observeReviewWork(s.rt, s.gate);
    assert.ok(seen.observation_ids.length > 5, 'the incumbent skill produces verified failures on review work');

    const first = await runExperiment(s.rt, s.gate, 'exec-interface-compat-naive');
    if (process.env.SWARM2_DEBUG) console.log(JSON.stringify(brief(first.receipt), null, 1));
    assert.equal(first.receipt.decision, 'reject', 'the first attempt helps but blocks safe changes');
    assert.ok(first.receipt.gates.some((g) => g.id === 'false_alarms_within_margin' && g.verdict === 'FAILED'));
    assert.equal(first.receipt.release_manifest, null);

    const second = await runExperiment(s.rt, s.gate, 'exec-interface-compat', { revises_experiment: first.experiment.id });
    if (process.env.SWARM2_DEBUG) console.log(JSON.stringify(brief(second.receipt), null, 1));
    assert.notEqual(second.receipt.evaluation.holdout_set, first.receipt.evaluation.holdout_set, 'a revised candidate is never scored on cases its lineage has already seen results for');
    assert.equal(second.receipt.decision, 'accept');
    const acc = second.receipt.comparisons.find((c) => c.metric === 'accuracy')!;
    assert.ok(acc.ci95_vs_incumbent![0] > 0, 'the interval of the improvement excludes zero');
    assert.ok(second.receipt.gates.filter((g) => g.kind === 'HARD_GATE').every((g) => g.verdict === 'PASSED'));
    assert.equal(second.receipt.isolation.intact, true);
    const rel = second.receipt.release_manifest!;
    assert.equal(rel.status, 'canary');
    assert.equal(rel.components.execution.version, 2);
    assert.equal(rel.components.coordination.version, 1, 'the other levels keep their versions');
    assert.equal(rel.rollback_target, 'r1');
    assert.equal(s.rt.registry.active(), 'r1', 'accepting a candidate does not make it the default');
    assert.equal(s.gate.verifyLedger().ok, true);
    await assert.rejects(() => s.gate.evaluate(second.experiment.id), /already decided/);
  } finally {
    s.cleanup();
  }
});

test('rejection: a cheaper candidate that omits a required verification step is rejected', async () => {
  const s = setup();
  try {
    const r = await runExperiment(s.rt, s.gate, 'exec-fast-review');
    if (process.env.SWARM2_DEBUG) console.log(JSON.stringify(brief(r.receipt), null, 1));
    const steps = r.receipt.comparisons.find((c) => c.metric === 'steps_per_review')!;
    assert.ok(steps.diff_vs_incumbent! < 0, 'it really is cheaper');
    assert.equal(r.receipt.decision, 'reject');
    assert.ok(r.receipt.gates.some((g) => g.id === 'required_steps_present' && g.verdict === 'FAILED'));
    assert.match(r.receipt.justification, /required verification steps/i);
  } finally {
    s.cleanup();
  }
});

test('isolation: candidate code cannot change the rules, the records or the release pointer', async () => {
  const s = setup();
  try {
    const policyBefore = readFileSync(join(PROTECTED_SRC, 'policy.json'), 'utf8');
    // As submitted, it is rejected before any of its code runs.
    const screened = await runExperiment(s.rt, s.gate, 'exec-tamper');
    assert.equal(screened.receipt.decision, 'reject');
    assert.ok(screened.receipt.gates.some((g) => g.id === 'no_forbidden_capabilities' && g.verdict === 'FAILED'));

    // Demonstration only: run it anyway and let it try.
    const forced = await runExperiment(s.rt, s.gate, 'exec-tamper', { force_execute_despite_screening: true });
    const reported = forced.receipt.isolation.notes.filter((n) => n.startsWith('candidate reported:'));
    if (process.env.SWARM2_DEBUG) console.log(forced.receipt.isolation.mode, reported);
    assert.equal(reported.length, 6);
    assert.ok(reported.every((n) => /denied/.test(n)), 'every attempt was denied');
    assert.equal(forced.receipt.isolation.intact, true);
    assert.equal(forced.receipt.decision, 'reject');
    assert.equal(readFileSync(join(PROTECTED_SRC, 'policy.json'), 'utf8'), policyBefore);
    assert.equal(s.rt.registry.active(), 'r1');
    assert.equal(s.gate.verifyLedger().ok, true);
    assert.equal(s.gate.integrity().ok, true);

    // A change to the rules made outside the authorized path is detected and blocks every decision.
    if (forced.receipt.isolation.mode !== 'enforced') return;
    writeFileSync(join(PROTECTED_SRC, 'policy.json'), policyBefore + ' ');
    try {
      assert.equal(s.gate.integrity().ok, false);
      const r = await runExperiment(s.rt, s.gate, 'exec-interface-compat');
      assert.equal(r.receipt.decision, 'reject');
      assert.ok(r.receipt.gates.some((g) => g.id === 'protected_integrity' && g.verdict === 'FAILED'));
    } finally {
      writeFileSync(join(PROTECTED_SRC, 'policy.json'), policyBefore);
    }
    assert.equal(s.gate.integrity().ok, true);
  } finally {
    s.cleanup();
  }
});
