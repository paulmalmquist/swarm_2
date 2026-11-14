/**
 * LIVE RUN of the cross-swarm mission — real model workers, not fixtures.
 *
 *   SWARM2_LIVE=1 node demos/live.ts [name]
 *
 * It refuses to run unless the operator has enabled live execution. The requests, the datasets
 * and the fixture application are synthetic; the workers are real `claude -p` processes. Steps the
 * scenario marks as templates stay scripted and are counted separately. Nothing here approves the
 * result: if the mission needs a person, the run stops and says so.
 *
 * Evidence is written to evidence/<name>/ (default: live-a).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/config.ts';
import { Coordinator } from '../src/coordination/coordinator.ts';
import type { ReviewPacket } from '../src/contracts/types.ts';
import { freshHome, scenarioRequests, writeEvidence } from './lib.ts';
import { LocalChiefOfStaff } from '../src/cos/port.ts';

const name = process.argv[2] ?? 'live-a';
const MAX_MS = Number(process.env.SWARM2_LIVE_MAX_MS ?? 25 * 60_000);

async function main(): Promise<void> {
  if (process.env.SWARM2_LIVE !== '1') {
    process.stderr.write('Live execution is off. This run uses real model calls; set SWARM2_LIVE=1 to allow it.\n');
    process.exit(2);
  }
  const home = join(REPO_ROOT, 'var', name);
  const out = join(REPO_ROOT, 'evidence', name);
  rmSync(out, { recursive: true, force: true });
  const rt = freshHome(home);
  const log: string[] = [];
  const co = new Coordinator(rt, { log: (m) => { log.push(`${new Date().toISOString()} ${m}`); process.stdout.write(`  ${m}\n`); } });
  const t0 = Date.now();
  try {
    const cos = new LocalChiefOfStaff(rt);
    const ing = cos.ingestRequests({ command: 'ingestRequests', actor: 'chief_of_staff', key: `${name}-ingest`, data: { requests: scenarioRequests() } });
    if (ing.source === 'unavailable') throw new Error(ing.reason);
    const cluster = ing.clusters[0]!;
    const sub = cos.submitMission({ command: 'submitMission', actor: 'chief_of_staff', key: `${name}-submit`, data: { title: 'Shared dataset-health capability', objective: 'Give every team one policy-driven way to see which datasets are stale, drifting or unmeasured, and who owns them.', request_ids: cluster.request_ids, scenario: 'shared-capability', provider_mode: 'live', priority: 2 } });
    if (sub.source === 'unavailable') throw new Error(sub.reason);
    const id = sub.mission.id;
    process.stdout.write(`LIVE mission ${id} submitted (${sub.source}); coordinating for at most ${Math.round(MAX_MS / 60000)} minutes\n`);

    const state = await co.runUntilIdle({ mission_id: id, max_ms: MAX_MS, poll_ms: 250 });
    await co.drain();
    const elapsed_ms = Date.now() - t0;
    const { store, kernel } = rt;
    const mission = store.missions.must(id);
    const tasks = store.tasks.where('"mission_id" = ?', id);
    const attempts = store.attempts.where('"mission_id" = ?', id).sort((a, b) => a.started_at.localeCompare(b.started_at));
    const keyOf = (task_id: string): string => tasks.find((t) => t.id === task_id)?.key ?? task_id;
    const model = attempts.filter((a) => a.provider_mode === 'live' && a.provider !== 'runtime');
    const scripted = attempts.filter((a) => a.provider === 'fixture');
    const sum = (f: (a: (typeof attempts)[number]) => number | null | undefined): number => model.reduce((x, a) => x + (f(a) ?? 0), 0);
    const verifications = store.verifications.where('"mission_id" = ?', id);
    const final = (criterion: string) => verifications.filter((v) => v.criterion_id === criterion).sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
    const acceptanceIds = [...new Set(verifications.filter((v) => v.criterion_id.startsWith('AC-')).map((v) => v.criterion_id))].sort();
    const observations = store.observations.where('"mission_id" = ?', id);
    const denied = store.events({ mission_id: id, type: 'worker_tool_denied', limit: 1000 });
    const decisions = store.decisions.where('"mission_id" = ?', id);
    const progress = cos.inspectProgress(id);
    const evidence = cos.retrieveEvidence(id);
    const packet: ReviewPacket | null = evidence.source === 'unavailable' ? null : evidence.packet;

    const summary = {
      label: 'LIVE MODEL EXECUTION on SYNTHETIC requests, datasets and fixture application',
      ran_at: new Date(t0).toISOString(),
      coordinator_state: state,
      mission: { id, status: mission.status, release_id: mission.release_id, provider_mode: mission.provider_mode, data_class: mission.data_class },
      reached_review: mission.status === 'review_ready',
      elapsed_ms,
      tasks: { total: tasks.length, by_status: tasks.reduce((a: Record<string, number>, t) => ((a[t.status] = (a[t.status] ?? 0) + 1), a), {}) },
      execution: {
        model_attempts: model.length,
        scripted_attempts: scripted.length,
        scripted_steps: [...new Set(scripted.map((a) => keyOf(a.task_id)))],
        runtime_steps: attempts.filter((a) => a.provider === 'runtime').length,
        models_served: [...new Set(model.map((a) => a.model_actual).filter(Boolean))],
        tokens_out: sum((a) => a.usage?.output_units),
        tokens_in_including_cache: sum((a) => (a.usage?.input_units ?? 0) + (a.usage?.cache_read_units ?? 0) + (a.usage?.cache_write_units ?? 0)),
        cost_usd_list_price_estimate: Number(sum((a) => a.usage?.reported_cost).toFixed(4)),
        cost_note: 'A client-side estimate at list prices. It is not billing.',
        // Attempts that ended without saying what they used: with any, tokens and cost are lower bounds.
        attempts_without_reported_usage: rt.kernel.unreportedUsage(id),
        worker_wall_ms: sum((a) => a.usage?.wall_ms),
      },
      attempts: attempts.filter((a) => a.provider !== 'runtime').map((a) => ({ task: keyOf(a.task_id), attempt: a.attempt_no, provider: a.provider, model_requested: a.model_requested, model_actual: a.model_actual, status: a.status, wall_ms: a.usage?.wall_ms ?? null, output_tokens: a.usage?.output_units ?? null, cost_usd_list_price_estimate: a.usage?.reported_cost ?? null, error: a.error?.code ?? null })),
      acceptance: acceptanceIds.map((c) => ({ criterion: c, verdict: final(c)?.verdict ?? 'none', independent: final(c)?.independent ?? null, verdict_history: verifications.filter((v) => v.criterion_id === c).sort((a, b) => a.created_at.localeCompare(b.created_at)).map((v) => v.verdict) })),
      rework: observations.filter((o) => o.kind === 'rework').map((o) => ({ task: o.task_id ? keyOf(o.task_id) : null, why: String((o.details as { reason?: string }).reason ?? '').slice(0, 700) })),
      integration_failures: observations.filter((o) => o.kind === 'integration_failure').length,
      acceptance_failures: observations.filter((o) => o.kind === 'acceptance_failure').length,
      execution_failures: observations.filter((o) => o.kind === 'execution_failure').map((o) => ({ task: o.task_id ? keyOf(o.task_id) : null, why: o.failure_class })),
      harness_denials: denied.map((e) => ({ task: e.payload.key, count: e.payload.count, denials: e.payload.denials })),
      decisions: decisions.map((d) => ({ kind: d.kind, status: d.status, owner: d.owner_kind, question: d.question.slice(0, 300) })),
      waiting_for_a_person: decisions.filter((d) => ['open', 'escalated'].includes(d.status) && d.requires_human).length,
      budget: progress.source === 'unavailable' ? null : { spent: progress.missions[0]!.spent, limit: progress.missions[0]!.budget },
      events: store.events({ mission_id: id, limit: 100_000 }).length,
      event_chain_intact: store.verifyEventChain().ok,
    };
    writeEvidence(out, 'summary.json', summary);
    writeEvidence(out, 'coordinator.log', log.join('\n') + '\n');
    writeEvidence(out, 'timeline.json', store.events({ mission_id: id, limit: 100_000 }).map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, task: e.task_id ? keyOf(e.task_id) : null, actor: e.actor_kind, payload: e.payload })));
    for (const key of ['discovery/overlap-report', 'plan/acceptance-criteria', 'knowledge/mission-notes', 'review/packet.md']) {
      const v = kernel.currentVersion(id, key);
      const text = v ? kernel.readArtifact(v) : null;
      if (text) writeEvidence(out, `artifacts/${key.replace(/\//g, '__')}${/\.md$/.test(key) ? '' : '.json'}`, text);
    }
    for (const t of tasks.filter((x) => x.executor === 'worker')) {
      const said = store.getMeta<Record<string, unknown>>(`task:${t.id}:output:g${t.generation}`);
      if (said) writeEvidence(out, `worker-reports/${t.key}.json`, { task: t.key, attempt: said.attempt_no, summary: said.summary, criteria_claims: said.criteria_claims, remaining_uncertainty: said.remaining_uncertainty, questions: said.questions });
    }
    // The code the model workers wrote, as the integration branch holds it.
    const repo = join(rt.paths.workspaces, id, 'repo');
    if (existsSync(repo)) {
      const git = (args: string[]): string => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).stdout ?? '';
      writeEvidence(out, 'code/integration-log.txt', git(['log', '--oneline', '--stat', 'integration']));
      for (const f of ['src/engine/evaluate.ts', 'src/report/report.ts']) {
        const text = git(['show', `integration:${f}`]);
        if (text) writeEvidence(out, `code/${f.replace(/\//g, '__')}`, text);
      }
    }
    const lines = [
      `# Live run: ${name}`,
      '',
      '**LIVE MODEL EXECUTION.** The workers were real model processes. The requests, datasets and fixture application are SYNTHETIC.',
      `Steps that stayed scripted from the scenario (${summary.execution.scripted_steps.join(', ') || 'none'}) are counted separately and were recorded as fixture attempts.`,
      '',
      `- Mission status: **${mission.status}**${summary.reached_review ? ' — a review packet is waiting for a decision' : ''}; coordinator ${state}; ${Math.round(elapsed_ms / 1000)} s elapsed.`,
      `- Model attempts: ${model.length} (${summary.execution.models_served.join(', ')}); scripted attempts: ${scripted.length}; runtime steps: ${summary.execution.runtime_steps}.`,
      `- Output tokens: ${summary.execution.tokens_out}; list-price cost estimate: ${summary.execution.cost_usd_list_price_estimate} USD (not billing).${summary.execution.attempts_without_reported_usage ? ` Both are lower bounds: ${summary.execution.attempts_without_reported_usage} model attempt(s) ended without reporting what they used.` : ''}`,
      `- Rework: ${summary.rework.length}; integration failures: ${summary.integration_failures}; acceptance failures: ${summary.acceptance_failures}; tasks that failed without a verifiable result: ${summary.execution_failures.length}; tool uses refused by the worker harness: ${summary.harness_denials.reduce((a, d) => a + Number(d.count), 0)}.`,
      `- Decisions waiting for a person: ${summary.waiting_for_a_person}.`,
      '',
      '## Acceptance criteria (verified by the verification swarm on tests the workers never saw)',
      '',
      ...(summary.acceptance.length ? summary.acceptance.map((a) => `- ${a.criterion}: **${a.verdict}** (history: ${a.verdict_history.join(' → ')})`) : ['- Not reached.']),
      '',
      '## Attempts',
      '',
      '| Task | Attempt | Provider | Model served | Status | Seconds | Output tokens | Cost estimate (USD) |',
      '|---|---|---|---|---|---|---|---|',
      ...summary.attempts.map((a) => `| ${a.task} | ${a.attempt} | ${a.provider} | ${a.model_actual ?? '—'} | ${a.status}${a.error ? ` (${a.error})` : ''} | ${a.wall_ms === null ? '—' : (a.wall_ms / 1000).toFixed(1)} | ${a.output_tokens ?? '—'} | ${a.cost_usd_list_price_estimate ?? '—'} |`),
      '',
      ...(summary.rework.length ? ['## Why work was sent back', '', ...summary.rework.map((r) => `- ${r.task}: ${r.why}`), ''] : []),
      packet ? `Decision requested of the chief of staff: ${packet.decision_requested?.question ?? '—'}` : 'No review packet was produced.',
      '',
      'Files: `summary.json`, `timeline.json`, `coordinator.log`, `artifacts/` (documents the model workers wrote), `worker-reports/` (what each worker said, including its stated uncertainty), `code/` (what was integrated).',
    ];
    writeEvidence(out, 'README.md', lines.join('\n') + '\n');
    process.stdout.write(`\n${lines.slice(4, 9).join('\n')}\n→ evidence/${name}/\n`);
  } finally {
    co.stop();
    rt.close();
  }
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack : err) + '\n');
  process.exit(1);
});
