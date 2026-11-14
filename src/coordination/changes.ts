import type { ArtifactKind, Command } from '../contracts/types.ts';
import type { Impact } from '../kernel/kernel.ts';
import type { Runtime } from '../runtime.ts';
import { SwarmError } from '../lib/util.ts';

/**
 * Apply an authorized change to an upstream artifact (for example a revised interface contract).
 *
 * The new version supersedes the old one; every task that consumed the old version is marked,
 * in-flight attempts are fenced, and a mission that was already waiting for review is reopened —
 * its pending decision and draft referred to evidence that is no longer current, so they are
 * superseded and withdrawn rather than left for someone to approve by mistake.
 */
export function applyUpstreamChange(rt: Runtime, cmd: Command<{ mission_id: string; key: string; content: string; reason: string }>): { version_no: number; created: boolean; impacts: Impact[]; pids_to_stop: number[]; reopened: boolean } {
  const { store, kernel } = rt;
  return store.idempotent(cmd.key, 'applyUpstreamChange', cmd.data, () => {
    const m = store.missions.must(cmd.data.mission_id);
    if (['cancelled', 'failed'].includes(m.status)) throw new SwarmError('mission_closed', `Mission ${m.id} is ${m.status}`);
    const artifact = store.artifacts.first('"mission_id" = ? AND "key" = ?', m.id, cmd.data.key);
    if (!artifact) throw new SwarmError('unknown_artifact', `Mission ${m.id} has no artifact ${cmd.data.key}`);
    const prev = kernel.currentVersion(m.id, cmd.data.key);
    const res = kernel.publishVersion({
      mission_id: m.id,
      key: cmd.data.key,
      kind: artifact.kind as ArtifactKind,
      media_type: prev?.media_type ?? 'application/json',
      content: cmd.data.content,
      produced_by_task_id: prev?.produced_by_task_id ?? null,
      produced_by_attempt: prev?.produced_by_attempt ?? null,
      inputs: prev?.input_manifest ?? [],
      release_id: m.release_id,
      source: kernel.sourceOf(m.id),
    });
    store.emit({ type: 'upstream_change_applied', mission_id: m.id, actor_id: cmd.actor, actor_kind: 'chief_of_staff', payload: { key: cmd.data.key, version_no: res.version.version_no, created: res.created, reason: cmd.data.reason, affected: res.impacts.map((i) => ({ key: i.key, action: i.action })) }, idempotency_key: cmd.key });
    let reopened = false;
    if (res.impacts.length && ['review_ready', 'completed', 'blocked'].includes(m.status)) {
      const review = store.getMeta<{ decision_id: string; draft_id: string }>(`mission:${m.id}:review`);
      if (review) {
        const d = store.decisions.get(review.decision_id);
        if (d && ['open', 'escalated'].includes(d.status)) {
          store.decisions.put({ ...d, status: 'superseded' });
          store.emit({ type: 'decision_superseded', mission_id: m.id, actor_id: 'runtime', actor_kind: 'runtime', payload: { decision_id: d.id, why: `its evidence predates ${cmd.data.key} v${res.version.version_no}` } });
        }
        const dr = store.drafts.get(review.draft_id);
        if (dr && dr.status === 'awaiting_review') store.drafts.put({ ...dr, status: 'withdrawn', review_note: `withdrawn: ${cmd.data.key} changed` });
      }
      kernel.setMissionStatus(m.id, 'active', cmd.actor, { reason: `reopened by change to ${cmd.data.key}` });
      reopened = true;
    }
    return { version_no: res.version.version_no, created: res.created, impacts: res.impacts, pids_to_stop: res.impacts.flatMap((i) => i.pids), reopened };
  }).result;
}
