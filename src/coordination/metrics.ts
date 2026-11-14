import type { Outcome } from '../contracts/types.ts';
import type { Runtime } from '../runtime.ts';
import { newId } from '../lib/util.ts';

/** Time each task spent ready but not yet leased, from the event log. */
function waits(rt: Runtime, mission_id: string): Map<string, { wait_ms: number; accepted_at: number | null }> {
  const ready = new Map<string, number>();
  const out = new Map<string, { wait_ms: number; accepted_at: number | null }>();
  for (const e of rt.store.events({ mission_id })) {
    if (!e.task_id) continue;
    const t = Date.parse(e.ts);
    if (e.type === 'task_ready' || e.type === 'task_requeued' || e.type === 'task_rework') ready.set(e.task_id, t);
    else if (e.type === 'task_leased' && ready.has(e.task_id)) {
      const cur = out.get(e.task_id) ?? { wait_ms: 0, accepted_at: null };
      cur.wait_ms += Math.max(0, t - ready.get(e.task_id)!);
      out.set(e.task_id, cur);
      ready.delete(e.task_id);
    } else if (e.type === 'task_accepted') {
      const cur = out.get(e.task_id) ?? { wait_ms: 0, accepted_at: null };
      cur.accepted_at = t;
      out.set(e.task_id, cur);
    }
  }
  return out;
}

/** Waiting accumulated along the chain of prerequisites that finished last. */
export function criticalPath(rt: Runtime, mission_id: string): { keys: string[]; wait_ms: number } {
  const w = waits(rt, mission_id);
  const tasks = rt.store.tasks.where('"mission_id" = ?', mission_id).filter((t) => t.executor !== 'container');
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let cur = tasks.filter((t) => w.get(t.id)?.accepted_at).sort((a, b) => w.get(b.id)!.accepted_at! - w.get(a.id)!.accepted_at!)[0];
  const keys: string[] = [];
  let wait_ms = 0;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    keys.unshift(cur.key);
    wait_ms += w.get(cur.id)?.wait_ms ?? 0;
    const preds = [...rt.kernel.dependenciesOf(cur.id), ...rt.kernel.verificationTargets(cur.id)]
      .flatMap((d) => {
        const t = byId.get(d);
        // A prerequisite on a team means "the last task of that team".
        return t ? [t] : rt.store.tasks.where('"parent_task_id" = ?', d).filter((k) => k.executor !== 'container');
      })
      .filter((t) => w.get(t.id)?.accepted_at);
    cur = preds.sort((a, b) => w.get(b.id)!.accepted_at! - w.get(a.id)!.accepted_at!)[0];
  }
  return { keys, wait_ms };
}

/** Record the mission outcome from persisted state. Unmeasured values stay null; they are never zero. */
export function recordOutcome(rt: Runtime, mission_id: string): Outcome {
  const { store, kernel, comms } = rt;
  const m = store.missions.must(mission_id);
  const tasks = store.tasks.where('"mission_id" = ?', mission_id);
  const leaf = tasks.filter((t) => t.executor !== 'container');
  const criterion_results: Outcome['criterion_results'] = [];
  for (const t of leaf) {
    const vs = store.verifications.where('"task_id" = ? AND "generation" = ?', t.id, t.generation);
    for (const c of t.contract.acceptance_criteria) {
      const latest = vs.filter((v) => v.criterion_id === c.criterion_id).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)).at(-1);
      criterion_results.push({ criterion_id: c.criterion_id, verdict: latest?.verdict ?? 'inconclusive', independent: latest?.independent ?? false });
    }
  }
  const obs = store.observations.where('"mission_id" = ?', mission_id);
  const events = store.events({ mission_id });
  const overhead = comms.overhead(mission_id);
  const verified_success = leaf.length > 0 && leaf.every((t) => t.status === 'accepted' || t.status === 'not_selected') && leaf.every((t) => t.status !== 'accepted' || t.contract.verification.method === 'none' || kernel.acceptanceGaps(t).length === 0);
  const outcome: Outcome = {
    id: newId('out'),
    mission_id,
    task_id: null,
    terminal_state: 'accepted',
    verified_success,
    criterion_results,
    escaped_defects: store.getMeta<number>(`mission:${mission_id}:escaped_defects`) ?? null,
    rework_count: obs.filter((o) => o.kind === 'rework').length,
    integration_failures: obs.filter((o) => o.kind === 'integration_failure').length,
    human_corrections: obs.filter((o) => o.kind === 'human_correction').length,
    recovery_events: events.filter((e) => ['lease_expired', 'attempt_orphaned'].includes(e.type)).length,
    total_usage: kernel.budget.spent(m.budget_account_id),
    elapsed_ms: Math.max(0, store.clock.now() - Date.parse(m.created_at)),
    critical_path_wait_ms: criticalPath(rt, mission_id).wait_ms,
    messages: overhead.messages,
    message_bytes: overhead.bytes,
    release_id: m.release_id,
    source: kernel.sourceOf(mission_id),
    label_source: 'executable_check',
    created_at: store.clock.iso(),
  };
  for (const prior of store.outcomes.where('"mission_id" = ? AND "task_id" IS NULL', mission_id)) store.outcomes.delete(prior.id);
  store.outcomes.put(outcome);
  store.emit({ type: 'outcome_recorded', mission_id, actor_id: 'runtime', actor_kind: 'runtime', payload: { verified_success, rework: outcome.rework_count, integration_failures: outcome.integration_failures, recovery_events: outcome.recovery_events, elapsed_ms: outcome.elapsed_ms }, release_id: m.release_id });
  return outcome;
}
