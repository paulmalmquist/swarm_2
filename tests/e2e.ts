import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/config.ts';
import { LocalChiefOfStaff, type RawRequest } from '../src/cos/port.ts';
import { type Runtime, ensureBaseline, openRuntime } from '../src/runtime.ts';

export function scenarioRequests(): RawRequest[] {
  return (JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures/scenarios/shared-capability/requests.json'), 'utf8')) as { requests: RawRequest[] }).requests;
}

export function freshRuntime(limits = {}): { rt: Runtime; home: string; cleanup(): void } {
  const home = mkdtempSync(join(tmpdir(), 'swarm2-e2e-'));
  const rt = openRuntime({ home, limits });
  ensureBaseline(rt);
  return { rt, home, cleanup: () => { rt.close(); rmSync(home, { recursive: true, force: true }); } };
}

export function submitScenario(rt: Runtime, key = 'e2e'): { cos: LocalChiefOfStaff; mission_id: string } {
  const cos = new LocalChiefOfStaff(rt);
  const ing = cos.ingestRequests({ command: 'ingestRequests', actor: 'chief_of_staff', key: `${key}-ingest`, data: { requests: scenarioRequests() } });
  if (ing.source === 'unavailable') throw new Error(ing.reason);
  const proposals = cos.proposals();
  if (proposals.source === 'unavailable') throw new Error(proposals.reason);
  const p = proposals.proposals[0]!;
  const sub = cos.submitMission({ command: 'submitMission', actor: 'chief_of_staff', key: `${key}-submit`, data: { title: 'Shared dataset-health capability', objective: 'Give every team one policy-driven way to see which datasets are stale, drifting or unmeasured, and who owns them.', request_ids: p.request_ids, scenario: 'shared-capability', priority: 2 } });
  if (sub.source === 'unavailable') throw new Error(sub.reason);
  return { cos, mission_id: sub.mission.id };
}

