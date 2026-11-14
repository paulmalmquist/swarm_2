import { readdirSync } from 'node:fs';
import { CANDIDATE_LIBRARY, observeReviewWork, runExperiment } from '../evolution/loop.ts';
import { installArena } from '../evolution/arena.ts';
import { renderReceipt } from '../evolution/receipts.ts';
import { openRuntime } from '../runtime.ts';
import { SwarmError } from '../lib/util.ts';
import { Gate } from './gate.ts';

const print = (v: unknown): void => void process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v, null, 2)) + '\n');

/** `swarm2 gate …` and `swarm2 evolve …`. */
export async function gateCli(group: string, args: string[], home?: string): Promise<void> {
  const rt = openRuntime({ home });
  const gate = new Gate(rt);
  installArena(gate);
  const flag = (n: string): string | undefined => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
  const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--') && !['md'].includes(args[i - 1]!.slice(2))));
  const sub = pos[0] ?? 'status';
  try {
    if (group === 'gate') {
      switch (sub) {
        case 'init':
          return print(gate.init());
        case 'status':
          gate.init();
          return print({ isolation: gate.iso, integrity: gate.integrity(), ledger: gate.verifyLedger(), active_release: rt.registry.active(), releases: rt.registry.list().map((m) => ({ id: m.release_id, status: m.status, basis: m.evidence_basis, execution: m.components.execution.version, coordination: m.components.coordination.version, evolution: m.components.evolution.version })), canaries: gate.canaries.where('1=1') });
        case 'experiments':
          return print(gate.experiments.where('1=1').map((e) => ({ id: e.id, level: e.level, title: e.title, stage: e.stage, decision: e.decision, receipt_id: e.receipt_id, release_id: e.release_id, holdout_set: e.protocol?.holdout_set })));
        case 'receipt': {
          if (!pos[1]) throw new SwarmError('usage', 'gate receipt needs a receipt id');
          const r = gate.receipt(pos[1]);
          return print(args.includes('--md') ? renderReceipt(r) : r);
        }
        case 'ledger':
          return print(gate.ledger(flag('experiment')));
        case 'dependents':
          if (!pos[1]) throw new SwarmError('usage', 'gate dependents needs a release id');
          return print(gate.dependents(pos[1]));
        case 'canary': {
          const [action, id] = [pos[1], pos[2]];
          if (!action || !id) throw new SwarmError('usage', 'gate canary start <release> | observe <canary> | retain <canary> | rollback <canary> --reason "..."');
          if (action === 'start') return print(gate.startCanary(id, { max_missions: Number(flag('max-missions') ?? 3), scenario: flag('scenario') ?? null }));
          if (action === 'observe') return print(await gate.observeCanary(id));
          if (action === 'retain') return print(gate.retain(id));
          if (action === 'rollback') return print(gate.rollback(id, flag('reason') ?? 'rolled back by the operator'));
          throw new SwarmError('usage', `unknown canary action ${action}`);
        }
        default:
          throw new SwarmError('usage', 'gate init | status | experiments | receipt <id> [--md] | ledger | dependents <release> | canary …');
      }
    }
    gate.init();
    switch (sub) {
      case 'candidates':
        return print(readdirSync(CANDIDATE_LIBRARY));
      case 'observe':
        return print(await observeReviewWork(rt, gate));
      case 'run': {
        if (!pos[1]) throw new SwarmError('usage', 'evolve run needs a candidate name (see `evolve candidates`)');
        const r = await runExperiment(rt, gate, pos[1], { revises_experiment: flag('revises') ?? null });
        return print({ experiment_id: r.experiment.id, decision: r.receipt.decision, justification: r.receipt.justification, receipt_id: r.receipt.receipt_id, release: r.receipt.release_manifest?.release_id ?? null, holdout_set: r.receipt.evaluation.holdout_set });
      }
      default:
        throw new SwarmError('usage', 'evolve candidates | observe | run <candidate> [--revises <experiment>]');
    }
  } finally {
    gate.close();
    rt.close();
  }
}
