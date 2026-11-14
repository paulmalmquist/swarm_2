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

/** Records grouped by owner team (teams sorted; datasets sorted within team). Each record appears once. */
export function groupByTeam(records: HealthRecord[]): Map<string, HealthRecord[]> {
  const groups = new Map<string, HealthRecord[]>();
  for (const r of records) {
    if (!groups.has(r.owner_team)) groups.set(r.owner_team, []);
    groups.get(r.owner_team)!.push(r);
  }
  const sorted = new Map<string, HealthRecord[]>();
  for (const team of [...groups.keys()].sort()) {
    sorted.set(team, groups.get(team)!.sort((a, b) => a.dataset_id.localeCompare(b.dataset_id)));
  }
  return sorted;
}

/** Row format: `dataset | freshness status | staleness minutes | threshold minutes | schema status`. */
export function renderSlaReport(records: HealthRecord[]): string {
  const lines: string[] = ['# Dataset freshness SLA report', ''];
  for (const [team, rows] of groupByTeam(records)) {
    lines.push(`## ${team}`, '', 'dataset | freshness | staleness_min | threshold_min | schema');
    for (const r of rows) {
      const s = r.freshness.staleness_minutes;
      lines.push(`${r.dataset_id} | ${r.freshness.status} | ${s === null ? '—' : s} | ${r.freshness.threshold_minutes} | ${r.schema.status}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function alertPayloads(records: HealthRecord[]): Alert[] {
  const alerts: Alert[] = [];
  for (const r of records) {
    const base = { dataset_id: r.dataset_id, owner_team: r.owner_team };
    if (r.freshness.status === 'stale') {
      alerts.push({ ...base, kind: 'stale', severity: 'critical', message: `${r.dataset_id} is stale: ${r.freshness.staleness_minutes} min old, threshold ${r.freshness.threshold_minutes} min` });
    } else if (r.freshness.status === 'unknown') {
      alerts.push({ ...base, kind: 'unknown_freshness', severity: 'warning', message: `${r.dataset_id} has never been measured; freshness is unknown` });
    }
    if (r.schema.status === 'drift') {
      const detail = r.schema.drift.map((d) => `${d.field} (${d.change})`).join(', ');
      alerts.push({ ...base, kind: 'schema_drift', severity: 'warning', message: `${r.dataset_id} schema drift: ${detail}` });
    }
  }
  return alerts;
}
