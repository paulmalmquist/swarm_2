import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcceptanceCriterion, LimitsProfile, Mission, Task, WorkOutput } from '../src/contracts/types.ts';
import { DEV_PROFILE, devAuthority, devBudget } from '../src/config.ts';
import { Kernel, type NewTask } from '../src/kernel/kernel.ts';
import { Comms } from '../src/kernel/comms.ts';
import { Intake } from '../src/kernel/intake.ts';
import { Store } from '../src/store/store.ts';
import { ManualClock, amounts } from '../src/lib/util.ts';

export interface Rig {
  dir: string;
  clock: ManualClock;
  store: Store;
  kernel: Kernel;
  comms: Comms;
  intake: Intake;
  cleanup(): void;
}

export function rig(limits: Partial<LimitsProfile> = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'swarm2-test-'));
  const clock = new ManualClock();
  const store = new Store(join(dir, 'swarm.db'), clock);
  const kernel = new Kernel(store, { ...DEV_PROFILE, ...limits }, join(dir, 'artifacts'));
  return {
    dir,
    clock,
    store,
    kernel,
    comms: new Comms(store),
    intake: new Intake(store),
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let n = 0;
export function mission(r: Rig, over: Partial<Parameters<Kernel['createMission']>[0]['data']> = {}): Mission {
  n++;
  return r.kernel.createMission({
    command: 'createMission',
    actor: 'chief_of_staff',
    key: `test-mission-${n}`,
    data: {
      title: `syn mission ${n}`,
      objective: 'synthetic objective',
      priority: 5,
      requested_by: 'chief_of_staff',
      accountable_human: 'paul',
      authorization: devAuthority(),
      budget: devBudget(),
      data_class: 'synthetic',
      provider_mode: 'fixture',
      scenario: null,
      request_ids: [],
      release_id: 'r1',
      ...over,
    },
  });
}

export function criterion(id: string, over: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return { criterion_id: id, description: `criterion ${id}`, verification_kind: 'executable', required_evidence_types: ['test_result'], mandatory: true, stakeholder: null, check: null, ...over };
}

export function task(r: Rig, m: Mission, key: string, over: Partial<NewTask> = {}): Task {
  return r.kernel.createTask({
    mission_id: m.id,
    parent_task_id: null,
    swarm_id: null,
    key,
    title: `task ${key}`,
    objective: `do ${key}`,
    executor: 'worker',
    assignee: { kind: 'agent', archetype: 'delivery', role: 'implementer' },
    owner_id: `owner-${key}`,
    acceptance_criteria: [criterion(`${key}-c1`)],
    depends_on: [],
    input_keys: [],
    required_outputs: [],
    verification: { method: 'executable', independent: true },
    authority: { ...devAuthority(), write_scope: ['src/**'] },
    reservation: amounts({ model_calls: 4, worker_invocations: 4, tokens: 10000, cost_usd_est: 0.5, wall_ms: 60000 }),
    budget_class: 'delivery',
    ...over,
  });
}

export function output(over: Partial<WorkOutput> = {}): WorkOutput {
  return { status: 'completed', summary: 'done', artifacts: [], evidence: [], criteria_claims: [], remaining_uncertainty: [], questions: [], proposals: [], ...over };
}

export const FIXTURE = { provider: 'fixture', provider_mode: 'fixture' as const, model_requested: null, uses_call_slot: true };

/** Lease, submit and independently verify a task in one step. */
export function complete(r: Rig, t: Task, out: Partial<WorkOutput> = {}): Task {
  const lease = r.kernel.claim(t.id, t.owner_id, FIXTURE);
  if (!lease) throw new Error(`could not lease ${t.key}`);
  r.kernel.submitResult(t.id, lease.token, output(out), null, { source: 'fixture' });
  for (const c of t.contract.acceptance_criteria) {
    r.kernel.recordVerification({ task_id: t.id, criterion_id: c.criterion_id, method: 'executable', verdict: 'pass', verifier_id: 'verifier' });
  }
  return r.kernel.acceptTask(t.id, 'verifier');
}
