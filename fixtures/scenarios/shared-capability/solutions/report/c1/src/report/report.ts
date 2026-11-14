/** The record shape this module consumes, as agreed in contracts/health-record.schema.json. */
export interface HealthRecord {
  dataset_id: string;
  owner_team: string;
  checked_at: string;
  freshness: { status: 'fresh' | 'stale' | 'unknown'; staleness_minutes: number | null; threshold_minutes: number };
  schema: { status: 'match' | 'drift' | 'unknown'; drift: { field: string; change: string }[] };
}

export interface Alert {
  dataset_id: string;
  owner_team: string;
  kind: 'stale' | 'schema_drift';
  detail: string;
}

/** An unmeasured value is shown as a dash. It is never rendered as zero. */
function cell(n: number | null): string {
  return n === null ? '—' : String(n);
}

/** SLA report grouped by owner team. */
export function renderSlaReport(records: HealthRecord[]): string {
  const teams = [...new Set(records.map((r) => r.owner_team))].sort();
  const lines: string[] = ['# Dataset health SLA report', ''];
  for (const team of teams) {
    lines.push(`## ${team}`, '', '| Dataset | Freshness | Staleness (min) | Threshold (min) | Schema |', '|---|---|---|---|---|');
    for (const r of records.filter((x) => x.owner_team === team)) {
      lines.push(`| ${r.dataset_id} | ${r.freshness.status} | ${cell(r.freshness.staleness_minutes)} | ${r.freshness.threshold_minutes} | ${r.schema.status} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** One alert per stale dataset and one per drifting schema. Unknown is not alerted as stale. */
export function alertPayloads(records: HealthRecord[]): Alert[] {
  const alerts: Alert[] = [];
  for (const r of records) {
    if (r.freshness.status === 'stale') {
      alerts.push({ dataset_id: r.dataset_id, owner_team: r.owner_team, kind: 'stale', detail: `${cell(r.freshness.staleness_minutes)} minutes old; threshold is ${r.freshness.threshold_minutes}` });
    }
    if (r.schema.status === 'drift') {
      alerts.push({ dataset_id: r.dataset_id, owner_team: r.owner_team, kind: 'schema_drift', detail: r.schema.drift.map((d) => `${d.field}: ${d.change}`).join('; ') });
    }
  }
  return alerts;
}
