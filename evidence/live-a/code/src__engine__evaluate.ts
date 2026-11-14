import { minutesBetween } from '../lib/time.ts';

type Fields = Record<string, string>;
export interface DatasetObservation { dataset_id: string; owner_team: string; last_loaded_at: string | null; observed_fields: Fields | null }
export interface DatasetPolicy { freshness_threshold_minutes?: number; declared_fields?: Fields }
export interface Policies { default?: { freshness_threshold_minutes?: number }; datasets?: Record<string, DatasetPolicy> }
export interface Drift { field: string; change: 'missing' | 'unexpected' | 'type_changed' }
export interface HealthRecord {
  dataset_id: string; owner_team: string; checked_at: string;
  freshness: { status: 'fresh' | 'stale' | 'unknown'; staleness_minutes: number | null; threshold_minutes: number };
  schema: { status: 'match' | 'drift' | 'unknown'; drift: Drift[] };
}

export function evaluateFreshness(lastLoadedAt: string | null | undefined, threshold: number, asOf: string): HealthRecord['freshness'] {
  const ts = lastLoadedAt == null ? NaN : Date.parse(lastLoadedAt);
  if (Number.isNaN(ts) || Number.isNaN(Date.parse(asOf))) return { status: 'unknown', staleness_minutes: null, threshold_minutes: threshold };
  const staleness = minutesBetween(lastLoadedAt as string, asOf);
  return { status: staleness > threshold ? 'stale' : 'fresh', staleness_minutes: staleness, threshold_minutes: threshold };
}

export function evaluateSchema(observed: Fields | null | undefined, declared: Fields | undefined): HealthRecord['schema'] {
  if (!observed || !declared) return { status: 'unknown', drift: [] };
  const drift: Drift[] = [];
  for (const [f, t] of Object.entries(declared)) {
    if (!(f in observed)) drift.push({ field: f, change: 'missing' });
    else if (observed[f] !== t) drift.push({ field: f, change: 'type_changed' });
  }
  for (const f of Object.keys(observed)) if (!(f in declared)) drift.push({ field: f, change: 'unexpected' });
  return { status: drift.length ? 'drift' : 'match', drift };
}

export function evaluateHealth(datasets: DatasetObservation[], policies: Policies, asOf: string): HealthRecord[] {
  return datasets.map((d) => {
    const p = policies.datasets?.[d.dataset_id];
    const threshold = p?.freshness_threshold_minutes ?? policies.default?.freshness_threshold_minutes;
    if (typeof threshold !== 'number') throw new Error(`no freshness threshold configured for ${d.dataset_id}`);
    return {
      dataset_id: d.dataset_id, owner_team: d.owner_team, checked_at: asOf,
      freshness: evaluateFreshness(d.last_loaded_at, threshold, asOf),
      schema: evaluateSchema(d.observed_fields, p?.declared_fields),
    };
  });
}
