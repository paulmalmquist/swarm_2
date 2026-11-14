// Renders the SLA report and alert payloads from HealthRecords (contract: syn:contract/health-record v1).
export interface HealthRecord {
  dataset_id: string;
  owner_team: string;
  checked_at: string;
  freshness: { status: 'fresh' | 'stale' | 'unknown'; staleness_minutes: number | null; threshold_minutes: number };
  schema: { status: 'match' | 'drift' | 'unknown'; drift: { field: string; change: 'missing' | 'unexpected' | 'type_changed' }[] };
}

export interface Alert {
  dataset_id: string;
  owner_team: string;
  kind: 'stale' | 'unknown_freshness' | 'schema_drift';
  severity: 'critical' | 'warning';
  message: string;
}

// A verdict is only 'fresh' when the contract says so AND a measurement exists.
export function freshnessVerdict(r: HealthRecord): 'fresh' | 'stale' | 'unknown' {
  const f = r.freshness;
  if (f.status === 'unknown' || f.staleness_minutes === null || f.staleness_minutes === undefined) return 'unknown';
  return f.status === 'stale' ? 'stale' : 'fresh';
}

export function groupByOwner(records: HealthRecord[]): Map<string, HealthRecord[]> {
  const groups = new Map<string, HealthRecord[]>();
  for (const r of records) {
    const list = groups.get(r.owner_team) ?? [];
    list.push(r);
    groups.set(r.owner_team, list);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function renderSlaReport(records: HealthRecord[]): string {
  const lines: string[] = ['# Dataset SLA report', ''];
  for (const [team, rows] of groupByOwner(records)) {
    lines.push(`## ${team}`, '', 'dataset | verdict | staleness_minutes | threshold_minutes | schema', '--- | --- | --- | --- | ---');
    for (const r of [...rows].sort((a, b) => a.dataset_id.localeCompare(b.dataset_id))) {
      const v = freshnessVerdict(r);
      const stale = v === 'unknown' ? 'n/a' : String(r.freshness.staleness_minutes);
      lines.push(`${r.dataset_id} | ${v} | ${stale} | ${r.freshness.threshold_minutes} | ${r.schema.status}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function alertPayloads(records: HealthRecord[]): Alert[] {
  const alerts: Alert[] = [];
  for (const r of records) {
    const v = freshnessVerdict(r);
    if (v === 'stale') {
      alerts.push({ dataset_id: r.dataset_id, owner_team: r.owner_team, kind: 'stale', severity: 'critical',
        message: `${r.dataset_id} is stale: ${r.freshness.staleness_minutes} min old, threshold ${r.freshness.threshold_minutes} min` });
    } else if (v === 'unknown') {
      alerts.push({ dataset_id: r.dataset_id, owner_team: r.owner_team, kind: 'unknown_freshness', severity: 'warning',
        message: `${r.dataset_id} has never been measured; freshness is unknown` });
    }
    if (r.schema.status === 'drift') {
      const detail = r.schema.drift.map((d) => `${d.field} (${d.change})`).join(', ');
      alerts.push({ dataset_id: r.dataset_id, owner_team: r.owner_team, kind: 'schema_drift', severity: 'critical',
        message: `${r.dataset_id} schema drift: ${detail}` });
    }
  }
  return alerts;
}
