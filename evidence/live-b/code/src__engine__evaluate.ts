import { minutesBetween } from '../lib/time.ts';

export type Observation = {
  dataset_id: string;
  owner_team: string;
  last_loaded_at: string | null;
  observed_fields: Record<string, string> | null;
};
export type Policies = {
  default?: { freshness_threshold_minutes?: number };
  datasets?: Record<string, { freshness_threshold_minutes?: number; declared_fields?: Record<string, string> }>;
};
export type Drift = { field: string; change: 'missing' | 'unexpected' | 'type_changed' };
export type HealthRecord = {
  dataset_id: string;
  owner_team: string;
  checked_at: string;
  freshness: { status: 'fresh' | 'stale' | 'unknown'; staleness_minutes: number | null; threshold_minutes: number };
  schema: { status: 'match' | 'drift' | 'unknown'; drift: Drift[] };
};

export function thresholdFor(id: string, policies: Policies): number {
  const t = policies.datasets?.[id]?.freshness_threshold_minutes ?? policies.default?.freshness_threshold_minutes;
  if (typeof t !== 'number' || !Number.isFinite(t)) throw new Error(`no freshness threshold configured for ${id}`);
  return t;
}

export function evaluateFreshness(lastLoadedAt: string | null | undefined, threshold: number, asOf: string): HealthRecord['freshness'] {
  const ms = lastLoadedAt ? Date.parse(lastLoadedAt) : NaN;
  if (Number.isNaN(ms)) return { status: 'unknown', staleness_minutes: null, threshold_minutes: threshold };
  const staleness = Math.max(0, minutesBetween(lastLoadedAt as string, asOf));
  return { status: staleness > threshold ? 'stale' : 'fresh', staleness_minutes: staleness, threshold_minutes: threshold };
}

export function evaluateSchema(observed: Record<string, string> | null | undefined, declared: Record<string, string> | undefined): HealthRecord['schema'] {
  if (!observed || !declared) return { status: 'unknown', drift: [] };
  const drift: Drift[] = [];
  for (const [f, type] of Object.entries(declared)) {
    if (!(f in observed)) drift.push({ field: f, change: 'missing' });
    else if (observed[f] !== type) drift.push({ field: f, change: 'type_changed' });
  }
  for (const f of Object.keys(observed)) if (!(f in declared)) drift.push({ field: f, change: 'unexpected' });
  return { status: drift.length ? 'drift' : 'match', drift };
}

export function evaluateHealth(datasets: Observation[], policies: Policies, asOf: string): HealthRecord[] {
  return datasets.map((d) => ({
    dataset_id: d.dataset_id,
    owner_team: d.owner_team,
    checked_at: asOf,
    freshness: evaluateFreshness(d.last_loaded_at, thresholdFor(d.dataset_id, policies), asOf),
    schema: evaluateSchema(d.observed_fields, policies.datasets?.[d.dataset_id]?.declared_fields),
  }));
}
