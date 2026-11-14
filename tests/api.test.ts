import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../src/api/server.ts';
import { scenarioRequests } from '../demos/lib.ts';

test('the API serves provenance envelopes and accepts only tokened, idempotent commands', async () => {
  const home = mkdtempSync(join(tmpdir(), 'swarm2-api-'));
  const s = await serve({ home, port: 0, run: true, quiet: true });
  const url = `http://127.0.0.1:${s.port}`;
  const get = async (p: string) => (await fetch(`${url}/v1/os/swarm${p}`)).json() as Promise<Record<string, unknown>>;
  const post = async (body: unknown, token = s.token) => {
    const r = await fetch(`${url}/v1/os/swarm/commands`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-swarm2-token': token }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  try {
    const o = await get('/overview');
    assert.equal(o.source, 'fixture');
    assert.equal(o.active_release, 'r1');
    assert.equal((await get('/metrics')).source, 'unavailable', 'no outcome yet: unavailable with a reason, not zeros');
    assert.match(String((await get('/metrics')).reason), /no mission/);

    assert.equal((await post({ command: 'ingestRequests', key: 'k1', data: { requests: scenarioRequests() } }, 'wrong')).status, 403);
    assert.equal((await post({ command: 'ingestRequests', data: { requests: [] } })).status, 400, 'a command without an idempotency key is refused');
    assert.equal((await post({ command: 'ingestRequests', key: 'k1', data: { requests: scenarioRequests() } })).status, 200);
    const planning = await get('/planning');
    const proposal = (planning.proposals as { cluster_id: string; request_ids: string[] }[])[0]!;
    const submit = { command: 'submitMission', key: `ui-submit-${proposal.cluster_id}`, data: { title: 'Shared dataset-health capability', objective: 'One view of dataset health.', request_ids: proposal.request_ids, scenario: 'shared-capability' } };
    const a = await post(submit);
    const b = await post(submit);
    assert.equal(a.status, 200);
    assert.deepEqual((b.body.mission as { id: string }).id, (a.body.mission as { id: string }).id, 'a double click does not create a second mission');
    assert.equal((await post({ ...submit, data: { ...submit.data, title: 'different' } })).status, 409);

    const id = (a.body.mission as { id: string }).id;
    const deadline = Date.now() + 60_000;
    let reviewing: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      reviewing = await get('/reviewing');
      if ((reviewing.ready as unknown[]).length) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const ready = (reviewing.ready as { id: string; packet: { acceptance: { verdict: string }[] }; decision: { id: string } }[])[0]!;
    assert.equal(ready.id, id);
    assert.ok(ready.packet.acceptance.every((x) => x.verdict === 'pass'));
    const own = await get(`/ownership?mission=${id}`);
    const nodes = (own.missions as { nodes: { id: string; key: string }[]; human_actions: unknown[] }[])[0]!;
    assert.equal(nodes.human_actions.length, 1, 'the graph shows that the next move belongs to a person');
    const detail = await get(`/tasks/${nodes.nodes.find((n) => n.key === 'delivery.integrate')!.id}`);
    assert.equal((detail.verifications as unknown[]).length >= 5, true);
    const decided = await post({ command: 'resolveDecision', key: 'ui-approve', actor: 'paul', data: { decision_id: ready.decision.id, chosen: 'approve', rationale: 'evidence is sufficient' } });
    assert.equal(decided.status, 200);
    const metrics = await get('/metrics');
    assert.deepEqual((metrics.primary as { independently_accepted_outcomes: unknown }).independently_accepted_outcomes, { value: 1, of: 1 });
    assert.equal((metrics.primary as { escaped_defects: unknown }).escaped_defects, null, 'unmeasured stays null');
    assert.match(await (await fetch(url)).text(), /swarm_2 review/);
  } finally {
    await s.close();
    rmSync(home, { recursive: true, force: true });
  }
});
