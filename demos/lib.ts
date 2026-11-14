import { Coordinator } from '../src/coordination/coordinator.ts';
import type { Gate } from '../src/gate/gate.ts';
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

/** Scripted approval is confined to synthetic fixture demonstrations, never live/real work. */
export async function completeFixtureCanary(rt: Runtime, gate: Gate, canaryId: string): Promise<string> {
  const c = gate.canaries.must(canaryId);
  const cos = new LocalChiefOfStaff(rt, (m) => gate.releaseFor(m));
  cos.onPinned = (canary, mission) => gate.noteCanaryMission(canary, mission);
  cos.ingestRequests({ command: 'ingestRequests', actor: 'fixture-reviewer', key: `${canaryId}:ingest`, data: { requests: scenarioRequests() } });
  const submitted = cos.submitMission({ command: 'submitMission', actor: 'fixture-reviewer', key: `${canaryId}:mission`, data: { title: 'Synthetic canary trial', objective: 'Exercise the release through delivery and review', scenario: 'shared-capability', provider_mode: 'fixture', data_class: 'synthetic', request_ids: scenarioRequests().slice(0, 4).map((r) => r.id) } });
  if (submitted.source === 'unavailable' || submitted.mission.release_id !== c.release_id) throw new Error('canary mission was not pinned');
  const co = new Coordinator(rt);
  try {
    await co.runUntilIdle({ mission_id: submitted.mission.id, max_ms: 60_000 });
    await co.drain();
    const m = rt.store.missions.must(submitted.mission.id);
    if (m.status !== 'review_ready' || m.provider_mode !== 'fixture' || m.data_class !== 'synthetic') throw new Error('fixture canary did not reach review');
    const review = rt.store.getMeta<{ decision_id: string }>(`mission:${m.id}:review`)!;
    cos.resolveDecision({ command: 'resolveDecision', actor: 'fixture-reviewer', key: `${canaryId}:approve`, data: { decision_id: review.decision_id, chosen: 'approve', rationale: 'SCRIPTED FIXTURE APPROVAL: exercises the lifecycle; not real user acceptance evidence' } });
    return m.id;
  } finally { co.stop(); await co.drain(); }
}
