/**
 * Worker-side entry point for the DETERMINISTIC FIXTURE PROVIDER.
 * Runs as its own process, heartbeats its lease, performs the scenario's scripted behavior,
 * and submits under its fencing token. Supports labeled injected faults.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CoordinationDef, ExecutionDef } from '../contracts/definitions.ts';
import type { Mission, Task, UsageRecord, WorkOutput } from '../contracts/types.ts';
import { DEV_PROFILE, REPO_ROOT } from '../config.ts';
import { Registry } from '../gate/registry.ts';
import { Kernel, parseToken } from '../kernel/kernel.ts';
import { Store } from '../store/store.ts';
import { sleep } from '../lib/util.ts';
import { Workspaces } from '../workspace/workspaces.ts';
import { dirname } from 'node:path';

export interface BehaviorCtx {
  task: Task;
  mission: Mission;
  workspace: string | null;
  inputs: Record<string, string>;
  params: Record<string, unknown>;
  faults: string[];
  attempt: number;
  generation: number;
  store: Store;
  kernel: Kernel;
  /** Definitions from the mission's pinned release. */
  coordination: CoordinationDef;
  execution: ExecutionDef;
}

export type Behavior = (ctx: BehaviorCtx) => Promise<WorkOutput> | WorkOutput;

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? '') : '';
}

async function main(): Promise<void> {
  const started = Date.now();
  const store = new Store(arg('db'));
  const kernel = new Kernel(store, { ...DEV_PROFILE, lease_ms: Number(arg('lease-ms')) || DEV_PROFILE.lease_ms }, arg('artifacts'));
  const taskId = arg('task');
  const token = parseToken(arg('token'));
  const workspace = arg('workspace') || null;
  const faults = arg('faults').split(',').filter(Boolean);
  const task = store.tasks.must(taskId);
  const mission = store.missions.must(task.mission_id);

  let beating = true;
  const beat = (): boolean => kernel.heartbeat(taskId, token, { pid: process.pid, ...(workspace ? { workspace: { dir: workspace, branch: arg('branch') || null, base_commit: arg('base') || null, head_commit: null } } : {}) });
  if (!beat()) {
    process.stderr.write('lease not held at start\n');
    process.exit(3);
  }
  process.stdout.write('started\n');
  const timer = setInterval(() => {
    if (beating && !beat()) process.exit(4); // fenced off: stop quietly
  }, 400);

  for (const f of faults) {
    store.emit({ type: 'fault_injected', mission_id: mission.id, task_id: taskId, actor_id: 'demo-driver', actor_kind: 'operator', payload: { key: task.key, fault: f, label: 'INJECTED FAULT', attempt: token.attempt } });
  }
  const slow = faults.find((f) => f.startsWith('slow:'));
  if (slow) await sleep(Number(slow.split(':')[1]));
  if (faults.includes('crash')) process.exit(137);
  if (faults.includes('hang')) {
    beating = false;
    await sleep(24 * 3600 * 1000);
  }
  const stall = faults.find((f) => f.startsWith('stall_then_submit:'));
  if (stall) {
    beating = false; // presumed dead by the runtime; submits later with a token that has gone stale
    await sleep(Number(stall.split(':')[1]));
  }

  const scenario = arg('scenario');
  const modPath = join(REPO_ROOT, 'fixtures', 'scenarios', scenario, 'behaviors.ts');
  if (!existsSync(modPath)) throw new Error(`no fixture behaviors for scenario ${scenario}`);
  const mod = (await import(pathToFileURL(modPath).href)) as { behaviors: Record<string, Behavior> };
  const behavior = mod.behaviors[task.key] ?? mod.behaviors[`role:${task.contract.assignee.role}`] ?? mod.behaviors['*'];
  if (!behavior) throw new Error(`no fixture behavior for task ${task.key}`);

  const inputs: Record<string, string> = {};
  for (const i of task.contract.inputs) {
    const v = store.versions.get(i.version_id);
    const content = v ? kernel.readArtifact(v) : null;
    if (content !== null) inputs[i.artifact_key] = content;
  }
  const registry = new Registry(join(dirname(arg('db')), 'protected'));
  const output = await behavior({
    task,
    mission,
    workspace,
    inputs,
    params: kernel.params(taskId),
    faults,
    attempt: token.attempt,
    generation: token.generation,
    store,
    kernel,
    coordination: registry.load<CoordinationDef>(mission.release_id, 'coordination'),
    execution: registry.load<ExecutionDef>(mission.release_id, 'execution'),
  });

  let git: { commit: string; tree: string; key: string } | null = null;
  let head_commit: string | null = null;
  if (workspace && existsSync(join(workspace, '.git'))) {
    const ws = new Workspaces(dirname(dirname(dirname(workspace))));
    const c = ws.commitAll(workspace, `${task.key}: ${output.summary.slice(0, 60)}`);
    const head = c ?? ws.head(workspace);
    head_commit = head.commit;
    const codeOut = task.contract.required_outputs.find((o) => o.kind === 'code');
    if (codeOut) git = { commit: head.commit, tree: head.tree, key: codeOut.key };
  }
  const usage: UsageRecord = {
    source: 'fixture-worker',
    meter_kind: 'fixture_declared',
    call_count: 1,
    input_units: null,
    output_units: null,
    cache_read_units: null,
    cache_write_units: null,
    wall_ms: Date.now() - started,
    reported_cost: null,
    currency: null,
    cost_basis: 'none',
    completeness: 'complete',
    observed_at: new Date().toISOString(),
  };
  const res = kernel.submitResult(taskId, token, output, usage, {
    source: 'fixture',
    git,
    ...(workspace ? { workspace: { dir: workspace, branch: arg('branch') || null, base_commit: arg('base') || null, head_commit } } : {}),
  });
  clearInterval(timer);
  store.close();
  if (!res.accepted) {
    process.stderr.write(`result rejected: ${res.reason}\n`);
    process.exit(5);
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack : err) + '\n');
  process.exit(1);
});
