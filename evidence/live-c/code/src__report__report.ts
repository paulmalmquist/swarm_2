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
  kind: 'stale' | 'freshness_unknown' | 'schema_drift';
  message: string;
}

const FRESHNESS = ['fresh', 'stale', 'unknown'];

function statusOf(r: HealthRecord): 'fresh' | 'stale' | 'unknown' {
  // Anything not positively fresh/stale (including null staleness) is unknown, never fresh.
  const s = r.freshness?.status;
  if (!FRESHNESS.includes(s)) return 'unknown';
  if (s === 'fresh' && r.freshness.staleness_minutes == null) return 'unknown';
  return s;
}

export function renderSlaReport(records: HealthRecord[]): string {
  const teams = new Map<string, HealthRecord[]>();
  for (const r of records) {
    if (!teams.has(r.owner_team)) teams.set(r.owner_team, []);
    teams.get(r.owner_team)!.push(r);
  }
  const lines: string[] = ['# NCR freshness SLA report', ''];
  for (const team of [...teams.keys()].sort()) {
    const rows = teams.get(team)!;
    const counts = { fresh: 0, stale: 0, unknown: 0 };
    for (const r of rows) counts[statusOf(r)]++;
    lines.push(`## ${team}`);
    lines.push(`fresh: ${counts.fresh} / ${rows.length} | stale: ${counts.stale} | unknown: ${counts.unknown}`);
    lines.push('', 'dataset | status | staleness_minutes | threshold_minutes | schema');
    for (const r of rows) {
      const st = r.freshness.staleness_minutes;
      lines.push(`${r.dataset_id} | ${statusOf(r)} | ${st == null ? '—' : st} | ${r.freshness.threshold_minutes} | ${r.schema?.status ?? 'unknown'}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function alertPayloads(records: HealthRecord[]): Alert[] {
  const alerts: Alert[] = [];
  for (const r of records) {
    const status = statusOf(r);
    if (status === 'stale') {
      alerts.push({ dataset_id: r.dataset_id, owner_team: r.owner_team, kind: 'stale',
        message: `${r.dataset_id} is stale: ${r.freshness.staleness_minutes} min old, threshold ${r.freshness.threshold_minutes} min` });
    } else if (status === 'unknown') {
      alerts.push({ dataset_id: r.dataset_id, owner_team: r.owner_team, kind: 'freshness_unknown',
        message: `${r.dataset_id} has never been measured; freshness unknown` });
    }
    if (r.schema?.status === 'drift') {
      const d = (r.schema.drift ?? []).map((x) => `${x.field} (${x.change})`).join(', ');
      alerts.push({ dataset_id: r.dataset_id, owner_team: r.owner_team, kind: 'schema_drift',
        message: `${r.dataset_id} schema drift: ${d}` });
    }
  }
  return alerts;
}
