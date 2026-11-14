import type { IntakeRequest, StakeholderNeed, Task } from '../contracts/types.ts';
import type { Store } from '../store/store.ts';
import { newId, sha256, hashOf, SwarmError } from '../lib/util.ts';

const STOP = new Set(
  'a an and are as at be been but by can do each for from has have how i in is it its just my need needs of on one or our over so that the their them then there this to up was we what when which who why will with would you your us not no after before into also want wants every still'.split(
    ' ',
  ),
);

/** Capability vocabulary used to recognise that different requests point at the same underlying need. */
const CAPABILITY_TAGS: Record<string, string[]> = {
  'data-freshness': ['stale', 'freshness', 'fresh', 'late', 'old', 'refresh', 'refreshed', 'lag', 'sla', 'cadence', 'threshold', 'thresholds'],
  'schema-contract': ['schema', 'column', 'columns', 'rename', 'renamed', 'contract', 'contracts', 'drift', 'broke', 'breaking', 'field'],
  'dataset-health': ['dataset', 'datasets', 'table', 'tables', 'dashboard', 'dashboards', 'check', 'checks', 'health', 'monitor', 'alert', 'alerts', 'report'],
  'shared-capability': ['shared', 'reusable', 'duplicate', 'duplicated', 'hand-rolled', 'handrolled', 'each', 'configurable', 'policy', 'policies', 'standard'],
  licensing: ['license', 'licenses', 'licence', 'renewal', 'seat', 'seats', 'procurement', 'invoice'],
};

export function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().replace(/[^a-z0-9\- ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))];
}

export function signature(text: string): { terms: string[]; capability_tags: string[] } {
  const terms = tokenize(text);
  const tags = Object.entries(CAPABILITY_TAGS)
    .filter(([, words]) => words.some((w) => terms.includes(w)))
    .map(([tag]) => tag);
  return { terms, capability_tags: tags };
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Similarity between two requests. Lexical overlap only nominates a candidate — it does not, on its
 * own, prove two requests are the same work. Consolidation is a recorded decision.
 */
export function similarity(a: IntakeRequest['signature'], b: IntakeRequest['signature']): number {
  return 0.7 * overlap(a.capability_tags, b.capability_tags) + 0.3 * jaccard(a.terms, b.terms);
}

/**
 * Overlap coefficient: shared items over the smaller set. Two requests that describe different
 * symptoms (stale data, a renamed column) of one capability area share few tags in total but
 * most of the smaller set, which is what should nominate them.
 */
export function overlap(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
}

export interface Cluster {
  id: string;
  request_ids: string[];
  shared_tags: string[];
  shared_terms: string[];
  score: number;
}

export class Intake {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  /** Record a request once. Re-delivery of the same request id is a no-op. */
  ingest(r: Omit<IntakeRequest, 'signature' | 'cluster_id' | 'mission_id'>, onRevision?: (prior: IntakeRequest) => void): { request: IntakeRequest; duplicate: boolean } {
    return this.store.db.tx(() => {
      const existing = this.store.requests.get(r.id);
      if (r.source_revision !== undefined && (!Number.isSafeInteger(r.source_revision) || r.source_revision < 1)) throw new SwarmError('invalid_revision', 'Source revision must be a positive integer');
      const payload = (x: typeof r) => ({ source: x.source, stakeholder: x.stakeholder, team: x.team, text: x.text, data_class: x.data_class, withdrawn: x.withdrawn ?? false });
      if (existing) {
        const same = hashOf(payload(existing)) === hashOf(payload(r));
        const oldRev = existing.source_revision ?? 1, newRev = r.source_revision ?? 1;
        if (newRev < oldRev || (same && newRev === oldRev)) {
          this.store.emit({ type: 'duplicate_delivery_ignored', actor_id: 'intake', actor_kind: 'runtime', payload: { request_id: r.id, scope: 'intake', stale: newRev < oldRev } });
          return { request: existing, duplicate: true };
        }
        if (newRev === oldRev) throw new SwarmError('request_revision_conflict', 'Changed request content requires a newer source_revision');
        if (existing.source !== r.source) throw new SwarmError('request_source_conflict', 'A request ID cannot change its source');
        if (existing.mission_id && !same && !onRevision) throw new SwarmError('request_revision_requires_replan', 'Use the chief-of-staff port to revise an assigned request');
        if (!same) onRevision?.(existing);
        const next: IntakeRequest = { ...existing, ...r, signature: signature(r.text), cluster_id: null, mission_id: same ? existing.mission_id : null };
        this.store.setMeta(`request:${r.id}:revision:${oldRev}`, existing);
        this.store.requests.put(next);
        this.store.emit({ type: 'request_revised', actor_id: 'intake', actor_kind: 'runtime', payload: { request_id: r.id, from: oldRev, to: newRev, previous_mission_id: existing.mission_id, withdrawn: r.withdrawn ?? false } });
        return { request: next, duplicate: false };
      }
      const request: IntakeRequest = { ...r, signature: signature(r.text), cluster_id: null, mission_id: null };
      this.store.requests.put(request);
      this.store.emit({ type: 'request_received', actor_id: r.stakeholder, actor_kind: 'human', payload: { request_id: r.id, source: r.source, team: r.team, data_class: r.data_class, capability_tags: request.signature.capability_tags } });
      return { request, duplicate: false };
    });
  }

  /** Single-link clustering of unassigned requests above a similarity threshold. */
  cluster(threshold = 0.3): Cluster[] {
    return this.store.db.tx(() => {
      const reqs = this.store.requests.where('"mission_id" IS NULL').filter((r) => !r.withdrawn).sort((a, b) => a.id.localeCompare(b.id));
      const parent = new Map(reqs.map((r) => [r.id, r.id]));
      const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
      const best = new Map<string, number>();
      for (let i = 0; i < reqs.length; i++) {
        for (let j = i + 1; j < reqs.length; j++) {
          const s = similarity(reqs[i]!.signature, reqs[j]!.signature);
          if (s >= threshold) {
            parent.set(find(reqs[i]!.id), find(reqs[j]!.id));
            best.set(reqs[i]!.id, Math.max(best.get(reqs[i]!.id) ?? 0, s));
            best.set(reqs[j]!.id, Math.max(best.get(reqs[j]!.id) ?? 0, s));
          }
        }
      }
      const groups = new Map<string, IntakeRequest[]>();
      for (const r of reqs) {
        const root = find(r.id);
        groups.set(root, [...(groups.get(root) ?? []), r]);
      }
      const clusters: Cluster[] = [];
      for (const members of groups.values()) {
        if (members.length < 2) continue;
        const ids = members.map((m) => m.id).sort();
        const id = 'cl_' + sha256(ids.join('|')).slice(0, 10);
        const shared = (pick: (r: IntakeRequest) => string[]) => pick(members[0]!).filter((t) => members.filter((m) => pick(m).includes(t)).length >= Math.ceil(members.length / 2));
        const cluster: Cluster = {
          id,
          request_ids: ids,
          shared_tags: shared((r) => r.signature.capability_tags),
          shared_terms: shared((r) => r.signature.terms),
          score: Math.min(...ids.map((i) => best.get(i) ?? 0)),
        };
        for (const m of members) {
          m.cluster_id = id;
          this.store.requests.put(m);
        }
        clusters.push(cluster);
        this.store.emit({ type: 'overlap_detected', actor_id: 'intake', actor_kind: 'runtime', payload: { cluster_id: id, request_ids: ids, shared_tags: cluster.shared_tags, score: Number(cluster.score.toFixed(3)), basis: 'lexical nomination; consolidation is a recorded decision' } });
      }
      return clusters;
    });
  }

  /** Each stakeholder keeps a distinct need, so consolidation cannot silently drop one. */
  recordNeed(n: Omit<StakeholderNeed, 'id' | 'status' | 'criterion_id'> & { criterion_id?: string | null }): StakeholderNeed {
    const rec: StakeholderNeed = { ...n, id: newId('need'), criterion_id: n.criterion_id ?? null, status: n.criterion_id ? 'mapped' : 'open' };
    this.store.needs.put(rec);
    return rec;
  }

  /** Needs with no acceptance criterion and no explicit deferral. */
  unmappedNeeds(mission_id: string): StakeholderNeed[] {
    return this.store.needs.where('"mission_id" = ? AND "status" = ?', mission_id, 'open');
  }

  /**
   * Find accepted work elsewhere whose scope matches. Reuse requires an identical scope signature,
   * an accepted and current result, and freshness within `max_age_ms`.
   */
  reusable(scope_signature: string, exclude_mission: string, max_age_ms: number): Task | undefined {
    const now = this.store.clock.now();
    return this.store.tasks
      .where('"scope_signature" = ? AND "status" = ? AND "currency" = ?', scope_signature, 'accepted', 'current')
      .filter((t) => t.mission_id !== exclude_mission && now - Date.parse(t.updated_at) <= max_age_ms)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  }
}

export function scopeSignature(parts: { capability: string; objective: string; input_hashes: string[] }): string {
  return sha256([parts.capability, tokenize(parts.objective).sort().join(' '), [...parts.input_hashes].sort().join(',')].join('|')).slice(0, 24);
}
