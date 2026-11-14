import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../src/config.ts';
import type { FaultSpec } from '../src/coordination/coordinator.ts';
import { LocalChiefOfStaff, type RawRequest } from '../src/cos/port.ts';
import type { RunEvent } from '../src/contracts/types.ts';
import { type Runtime, ensureBaseline, openRuntime } from '../src/runtime.ts';
import { sleep } from '../src/lib/util.ts';

export const NODE = [process.execPath, '--disable-warning=ExperimentalWarning'];

/** Start a coordinator as its own process so it can be killed like a real one. */
export function startCoordinator(home: string, opts: { maxMs?: number; env?: Record<string, string>; onLog?: (line: string) => void } = {}): { child: ChildProcess; exited: Promise<number | null>; logs: string[] } {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(NODE[0]!, [NODE[1]!, join(REPO_ROOT, 'src', 'cli.ts'), 'run', '--home', home, '--max-ms', String(opts.maxMs ?? 120_000)], { stdio: ['ignore', 'pipe', 'pipe'], env });
  const logs: string[] = [];
  child.stderr.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      logs.push(line);
      opts.onLog?.(line);
    }
  });
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  return { child, exited, logs };
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(40);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export function scenarioRequests(): RawRequest[] {
  return (JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures/scenarios/shared-capability/requests.json'), 'utf8')) as { requests: RawRequest[] }).requests;
}

export function freshHome(home: string, limits: Record<string, unknown> = {}): Runtime {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  const rt = openRuntime({ home, limits });
  ensureBaseline(rt);
  return rt;
}

/** Ingest the synthetic requests and submit the shared-capability mission the overlap nominates. */
export function submitSharedCapability(rt: Runtime, key: string, extra: { provider_mode?: 'fixture' | 'live'; release_id?: string } = {}): { cos: LocalChiefOfStaff; mission_id: string } {
  const cos = new LocalChiefOfStaff(rt);
  const ing = cos.ingestRequests({ command: 'ingestRequests', actor: 'chief_of_staff', key: `${key}-ingest`, data: { requests: scenarioRequests() } });
  if (ing.source === 'unavailable') throw new Error(ing.reason);
  const proposals = cos.proposals();
  if (proposals.source === 'unavailable' || !proposals.proposals[0]) throw new Error('no overlap was nominated');
  const sub = cos.submitMission({
    command: 'submitMission',
    actor: 'chief_of_staff',
    key: `${key}-submit`,
    data: { title: 'Shared dataset-health capability', objective: 'Give every team one policy-driven way to see which datasets are stale, drifting or unmeasured, and who owns them.', request_ids: proposals.proposals[0].request_ids, scenario: 'shared-capability', priority: 2, ...extra },
  });
  if (sub.source === 'unavailable') throw new Error(sub.reason);
  return { cos, mission_id: sub.mission.id };
}

/** LABELED INJECTED FAULTS for resilience demonstrations. */
export function injectFaults(rt: Runtime, mission_id: string, faults: FaultSpec[]): void {
  rt.store.setMeta(`faults:${mission_id}`, faults);
  rt.store.emit({ type: 'fault_plan_installed', mission_id, actor_id: 'demo-driver', actor_kind: 'operator', payload: { label: 'INJECTED FAULTS', faults } });
}

export function brief(e: RunEvent): string {
  const p = e.payload;
  const detail = ['key', 'token', 'status', 'reason', 'action', 'fault', 'to', 'verdict', 'criterion_id', 'workstream', 'presented', 'code'].filter((k) => p[k] !== undefined).map((k) => `${k}=${typeof p[k] === 'string' ? p[k] : JSON.stringify(p[k])}`).join(' ');
  return `#${e.seq} ${e.type}${detail ? ' ' + detail : ''}`;
}

export function writeEvidence(dir: string, name: string, value: unknown): string {
  const p = join(dir, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  return p;
}
