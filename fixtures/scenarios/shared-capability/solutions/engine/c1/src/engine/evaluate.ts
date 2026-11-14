import { minutesBetween } from '../lib/time.ts';

export interface DatasetObservation {
  dataset_id: string;
  owner_team: string;
  last_loaded_at: string | null;
  observed_fields: Record<string, string> | null;
}

export interface Policies {
  default: { freshness_threshold_minutes: number };
  datasets: Record<string, { freshness_threshold_minutes?: number; declared_fields?: Record<string, string> }>;
}

export interface HealthRecord {
  dataset_id: string;
  owner_team: string;
  checked_at: string;
  freshness: { status: 'fresh' | 'stale' | 'unknown'; staleness_minutes: number | null; threshold_minutes: number };
  schema: { status: 'match' | 'drift' | 'unknown'; drift: { field: string; change: 'missing' | 'unexpected' | 'type_changed' }[] };
}

/** Evaluate each dataset against its policy. Thresholds and declared fields come only from `policies`. */
export function evaluateHealth(datasets: DatasetObservation[], policies: Policies, asOf: string): HealthRecord[] {
  return datasets.map((d) => {
    const policy = policies.datasets[d.dataset_id] ?? {};
    const threshold = policy.freshness_threshold_minutes ?? policies.default.freshness_threshold_minutes;
    // An unmeasured dataset is unknown. It is never reported as fresh, and its staleness is never zero.
    const staleness = d.last_loaded_at === null ? null : minutesBetween(d.last_loaded_at, asOf);
    const freshness = { status: staleness === null ? ('unknown' as const) : staleness > threshold ? ('stale' as const) : ('fresh' as const), staleness_minutes: staleness, threshold_minutes: threshold };

    const drift: HealthRecord['schema']['drift'] = [];
    const declared = policy.declared_fields;
    let status: HealthRecord['schema']['status'] = 'unknown';
    if (declared && d.observed_fields) {
      for (const [field, type] of Object.entries(declared)) {
        if (!(field in d.observed_fields)) drift.push({ field, change: 'missing' });
        else if (d.observed_fields[field] !== type) drift.push({ field, change: 'type_changed' });
      }
      for (const field of Object.keys(d.observed_fields)) if (!(field in declared)) drift.push({ field, change: 'unexpected' });
      status = drift.length ? 'drift' : 'match';
    }
    return { dataset_id: d.dataset_id, owner_team: d.owner_team, checked_at: asOf, freshness, schema: { status, drift } };
  });
}
