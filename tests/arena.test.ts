import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gate } from '../src/gate/gate.ts';
import { installArena, makeWorld, runPolicy } from '../src/evolution/arena.ts';
import { runExperiment } from '../src/evolution/loop.ts';
import { openRuntime } from '../src/runtime.ts';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'swarm2-arena-'));
  const rt = openRuntime({ home });
  const gate = new Gate(rt);
  gate.init();
  installArena(gate);
  return { rt, gate, cleanup: () => { gate.close(); rt.close(); rmSync(home, { recursive: true, force: true }); } };
}

test('arena: episodes are deterministic and campaigns respect the budget', async () => {
  const s = setup();
  try {
    const a = makeWorld('unit-1', { log: 60, holdout: 40, fresh: 80 }, { complaints: true });
    const b = makeWorld('unit-1', { log: 60, holdout: 40, fresh: 80 }, { complaints: true });
    assert.deepEqual(a.log.map((c) => c.label.defect_class), b.log.map((c) => c.label.defect_class));
    const dir = s.rt.registry.componentDir('evolution', 1);
    const first = await runPolicy(s.gate, dir, 'policy.mjs', ['unit-1', 'unit-2', 'unit-3'], { complaints: true });
    const again = await runPolicy(s.gate, dir, 'policy.mjs', ['unit-1', 'unit-2', 'unit-3'], { complaints: true });
    assert.deepEqual(first, again, 'the same policy on the same episodes gives the same campaigns');
    for (const r of first) {
      assert.ok(r.spent <= r.budget);
      assert.equal(r.invalid_actions, 0);
      assert.ok(r.harm_after <= r.harm_before + 1e-9, 'only fixes that passed held-out judgement are kept, so harm does not rise');
    }
  } finally {
    s.cleanup();
  }
});

test('improving the improvement process: two policies, equal budgets, unseen episodes', async () => {
  const s = setup();
  try {
    const t0 = Date.now();
    const r = await runExperiment(s.rt, s.gate, 'evo-expected-value');
    const rec = r.receipt;
    if (process.env.SWARM2_DEBUG) {
      console.log(`decision=${rec.decision} in ${Date.now() - t0} ms\n${rec.justification}`);
      for (const c of rec.comparisons) console.log(` ${c.metric}: candidate ${c.candidate} vs incumbent ${c.incumbent}; diff ${c.diff_vs_incumbent} ci ${JSON.stringify(c.ci95_vs_incumbent)} | ${c.method}`);
      console.log(' regressions:', rec.known_regressions, '\n attempts:', JSON.stringify(rec.attempts));
    }
    assert.equal(rec.level, 'evolution');
    assert.equal(rec.evidence_basis, 'simulation', 'an arena result is labeled as a simulation');
    assert.equal(rec.evaluation.holdout_set, 'arena-A');
    assert.ok(rec.gates.filter((g) => g.kind === 'HARD_GATE').every((g) => g.verdict === 'PASSED'));
    const benefit = rec.comparisons.find((c) => c.metric === 'validated_benefit')!;
    const spent = rec.comparisons.find((c) => c.metric === 'budget_spent')!;
    assert.equal(benefit.n, 30);
    assert.ok(spent.candidate! <= 420 && spent.incumbent! <= 420, 'both policies had the same budget');
    assert.ok(rec.attempts.some((a) => a.kind === 'development') && rec.attempts.some((a) => a.kind === 'holdout'));
    // The decision follows from the interval, whatever it turns out to be.
    const [lo, hi] = benefit.ci95_vs_incumbent!;
    assert.equal(rec.decision, lo > 0 ? 'accept' : hi < 0 ? 'reject' : 'inconclusive');
    if (rec.decision === 'accept') {
      assert.equal(rec.release_manifest!.components.evolution.version, 2);
      assert.equal(rec.release_manifest!.components.execution.version, 1, 'only the evolution level changed');
    }
  } finally {
    s.cleanup();
  }
});
