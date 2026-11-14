import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../config.ts';
import type { ExternalEffect } from '../contracts/runtime.ts';
import type { Envelope } from '../contracts/types.ts';
import type { RawRequest } from '../cos/port.ts';
import type { Gate } from '../gate/gate.ts';
import type { Runtime } from '../runtime.ts';
import { newId } from '../lib/util.ts';

/**
 * Connector ports. swarm_2 talks to outside systems only through these interfaces.
 *
 * In the build environment none of the real systems was reachable, so every port has either a
 * clearly labeled LOCAL implementation with the same contract, or reports itself unavailable
 * with the exact integration requirement. Nothing here pretends to be connected.
 */

export interface ConnectorStatus {
  system: string;
  port: string;
  implementation: 'local-fixture' | 'local-file' | 'unavailable';
  available: boolean;
  reason: string;
  requirement: string;
  guarantee: string;
}

/** Where requests and engineering conversations come from (Slack, Jira). */
export interface RequestSourcePort {
  readonly system: string;
  fetch(): Envelope<{ requests: RawRequest[] }>;
}

/** Where analytical history goes (BigQuery). Operational state never lives here. */
export interface WarehousePort {
  readonly system: string;
  load(table: string, rows: Record<string, unknown>[], idempotency_key: string): Envelope<{ table: string; rows: number; location: string }>;
}

/** LOCAL FIXTURE: reads the synthetic requests file in the shape a Slack or Jira connector would deliver. */
export class LocalFixtureRequests implements RequestSourcePort {
  readonly system = 'local-fixture (stands in for Slack and Jira)';
  fetch(): Envelope<{ requests: RawRequest[] }> {
    const p = join(REPO_ROOT, 'fixtures', 'scenarios', 'shared-capability', 'requests.json');
    if (!existsSync(p)) return { source: 'unavailable', reason: 'the synthetic requests fixture is missing' };
    return { source: 'fixture', generated_at: new Date().toISOString(), requests: (JSON.parse(readFileSync(p, 'utf8')) as { requests: RawRequest[] }).requests };
  }
}

/**
 * Perform an effect outside the transactional store.
 *
 * Guarantee: at-least-once intent with reconciliation, never exactly-once. The intent is recorded
 * first. If the outcome is unknown (a crash or timeout after the call may have landed), the target
 * is asked what happened BEFORE anything is retried: applied → recorded as confirmed and not
 * repeated; not applied → retried; cannot tell → left unknown for a person, and not retried.
 */
export function performEffect<T extends Record<string, unknown>>(rt: Runtime, e: { adapter: string; action: string; idempotency_key: string; request: Record<string, unknown>; run: () => T; reconcile: () => 'applied' | 'not_applied' | 'unknown' }): { effect: ExternalEffect; response: T | null; executed: boolean } {
  const { store } = rt;
  let effect = store.effects.first('"idempotency_key" = ?', e.idempotency_key);
  if (effect?.status === 'confirmed') return { effect, response: effect.response as T | null, executed: false };
  if (effect && (effect.status === 'unknown' || effect.status === 'intended')) {
    const state = e.reconcile();
    store.emit({ type: 'external_effect_reconciled', actor_id: e.adapter, actor_kind: 'runtime', payload: { key: e.idempotency_key, action: e.action, found: state } });
    if (state === 'applied') {
      effect = { ...effect, status: 'confirmed', reconciled_at: store.clock.iso() };
      store.effects.put(effect);
      return { effect, response: effect.response as T | null, executed: false };
    }
    if (state === 'unknown') return { effect, response: null, executed: false };
  }
  if (!effect) {
    effect = { id: newId('eff'), adapter: e.adapter, action: e.action, idempotency_key: e.idempotency_key, status: 'intended', request: e.request, response: null, attempts: 0, created_at: store.clock.iso(), reconciled_at: null };
    store.effects.put(effect);
  }
  effect = { ...effect, attempts: effect.attempts + 1 };
  store.effects.put(effect);
  try {
    const response = e.run();
    effect = { ...effect, status: 'confirmed', response };
    store.effects.put(effect);
    return { effect, response, executed: true };
  } catch (err) {
    // The call may or may not have landed. That is recorded as unknown, not as failed.
    effect = { ...effect, status: 'unknown', response: { error: err instanceof Error ? err.message : String(err) } };
    store.effects.put(effect);
    store.emit({ type: 'external_effect_uncertain', actor_id: e.adapter, actor_kind: 'runtime', payload: { key: e.idempotency_key, action: e.action } });
    return { effect, response: null, executed: true };
  }
}

/** LOCAL FILE: writes newline-delimited JSON in the shape a warehouse load job takes. */
export class LocalJsonlWarehouse implements WarehousePort {
  readonly system = 'local-file (stands in for BigQuery)';
  private rt: Runtime;
  dir: string;
  /** Test hook: fail after the write has landed, to exercise reconciliation. */
  failAfterWrite = false;
  constructor(rt: Runtime, dir?: string) {
    this.rt = rt;
    this.dir = dir ?? join(rt.paths.home, 'export');
  }
  load(table: string, rows: Record<string, unknown>[], idempotency_key: string): Envelope<{ table: string; rows: number; location: string }> {
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${table}.jsonl`);
    const marker = join(this.dir, '.loads');
    const landed = (): boolean => existsSync(marker) && readFileSync(marker, 'utf8').split('\n').includes(idempotency_key);
    const res = performEffect(this.rt, {
      adapter: 'warehouse:local-jsonl',
      action: `load ${table}`,
      idempotency_key,
      request: { table, rows: rows.length },
      run: () => {
        appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
        appendFileSync(marker, idempotency_key + '\n');
        if (this.failAfterWrite) throw new Error('connection lost after the load was sent');
        return { table, rows: rows.length, location: file };
      },
      reconcile: () => (landed() ? 'applied' : 'not_applied'),
    });
    if (res.effect.status !== 'confirmed') return { source: 'unavailable', reason: `the outcome of loading ${table} is ${res.effect.status}; it will be reconciled before any retry` };
    return { source: 'fixture', generated_at: this.rt.store.clock.iso(), table, rows: rows.length, location: file };
  }
}

/** What is and is not connected, with the exact requirement for each real integration. */
export function connectorStatus(): ConnectorStatus[] {
  const none = (system: string, port: string, requirement: string): ConnectorStatus => ({ system, port, implementation: 'unavailable', available: false, reason: 'No connector, credential or network route to this system exists in the build environment.', requirement, guarantee: 'none: not implemented' });
  return [
    { system: 'Slack', port: 'RequestSourcePort', implementation: 'local-fixture', available: false, reason: 'The Slack connector was refused by the egress proxy (403).', requirement: 'Implement RequestSourcePort.fetch() against the approved Slack connector; map each message to {id, source, stakeholder, team, text, received_at}; enforce the channel allow-list and data classification before any text reaches a model.', guarantee: 'local fixture: deterministic, synthetic, read-only' },
    { system: 'Jira', port: 'RequestSourcePort', implementation: 'local-fixture', available: false, reason: 'The Atlassian connector was refused by the egress proxy (403).', requirement: 'Implement RequestSourcePort.fetch() against Jira; use the issue key as the request id so redelivery is idempotent. Creating or transitioning issues is an outward action and stays with the chief of staff.', guarantee: 'local fixture: deterministic, synthetic, read-only' },
    none('GitLab', 'CodeHostPort', 'Provide a read adapter for merge requests and diffs, and a draft-only adapter that turns an approved swarm_2 draft into a merge request through the existing protected path. swarm_2 itself never merges.'),
    { system: 'BigQuery', port: 'WarehousePort', implementation: 'local-file', available: false, reason: 'No project or dataset was authorized for this work.', requirement: 'Implement WarehousePort.load() with a load job per table using the idempotency key as the job id, so a retried load cannot duplicate rows. Run `swarm2 export` to see the row shapes and `export/schema.json` for field types.', guarantee: 'local file: at-least-once intent with reconciliation before retry; no duplicate rows for a repeated key' },
    none('dbt', 'CatalogPort', 'Expose model and metric definitions read-only so acceptance criteria can cite certified metric versions.'),
    none('Power BI', 'CatalogPort', 'Expose dataset and report lineage read-only so a mission can name the dashboards a change affects.'),
    none('OpenMetadata', 'CatalogPort', 'Expose table ownership, freshness and schema versions read-only; these replace the synthetic dataset observations in the fixture application.'),
    none('Dreamcatcher', 'AppHostPort', 'Provide the app manifest, route registration, theme and access policy so the review interface can be mounted inside the existing shell rather than run standalone.'),
    none('Strongbox', 'SecretsPort', 'Provide short-lived credentials to adapters at call time. swarm_2 stores no secrets and passes none to workers.'),
    none('Paul OS (chief of staff, Attention)', 'ChiefOfStaffPort', 'Implement ChiefOfStaffPort against Paul OS: missions are submitted from it, and every item in attention() is rendered in Attention, which stays the only surface that mutates. swarm_2 exposes the port in process, over HTTP (/v1/os/swarm/commands) and on the command line.'),
  ];
}

const ISO = { name: 'STRING', description: 'UTC ISO-8601 timestamp' };

/**
 * Export analytical history as newline-delimited JSON, one file per table.
 * Operational scheduling stays in the transactional store; this is a copy for analysis.
 */
export function exportAnalytics(rt: Runtime, gate: Gate, warehouse: WarehousePort): { tables: Record<string, number>; schema_path: string } {
  const { store } = rt;
  const lastSeq = Number(store.db.get<{ s: number }>('SELECT COALESCE(MAX(seq), 0) AS s FROM events')?.s ?? 0);
  const tables: Record<string, Record<string, unknown>[]> = {
    missions: store.missions.where('1=1').map((m) => ({ mission_id: m.id, title: m.title, status: m.status, priority: m.priority, release_id: m.release_id, provider_mode: m.provider_mode, data_class: m.data_class, scenario: m.scenario, created_at: m.created_at, updated_at: m.updated_at })),
    tasks: store.tasks.where('1=1').map((t) => ({ task_id: t.id, mission_id: t.mission_id, key: t.key, executor: t.executor, archetype: t.contract.assignee.archetype, status: t.status, depth: t.depth, attempts: t.attempt, generation: t.generation, retries: t.retries, repairs: t.repairs, currency: t.currency, created_at: t.created_at, updated_at: t.updated_at })),
    attempts: store.attempts.where('1=1').map((a) => ({ attempt_id: a.id, task_id: a.task_id, mission_id: a.mission_id, attempt_no: a.attempt_no, status: a.status, provider: a.provider, provider_mode: a.provider_mode, model_requested: a.model_requested, model_actual: a.model_actual, input_units: a.usage?.input_units ?? null, output_units: a.usage?.output_units ?? null, wall_ms: a.usage?.wall_ms ?? null, reported_cost: a.usage?.reported_cost ?? null, cost_basis: a.usage?.cost_basis ?? null, usage_completeness: a.usage?.completeness ?? null, started_at: a.started_at, ended_at: a.ended_at })),
    verifications: store.verifications.where('1=1').map((v) => ({ verification_id: v.id, mission_id: v.mission_id, task_id: v.task_id, criterion_id: v.criterion_id, method: v.method, verdict: v.verdict, independent: v.independent, generation: v.generation, created_at: v.created_at })),
    outcomes: store.outcomes.where('1=1').map((o) => ({ outcome_id: o.id, mission_id: o.mission_id, verified_success: o.verified_success, escaped_defects: o.escaped_defects, rework_count: o.rework_count, integration_failures: o.integration_failures, human_corrections: o.human_corrections, recovery_events: o.recovery_events, worker_invocations: o.total_usage.worker_invocations, model_calls: o.total_usage.model_calls, tokens: o.total_usage.tokens, cost_usd_est: o.total_usage.cost_usd_est, elapsed_ms: o.elapsed_ms, critical_path_wait_ms: o.critical_path_wait_ms, messages: o.messages, release_id: o.release_id, source: o.source, created_at: o.created_at })),
    observations: store.observations.where('1=1').map((o) => ({ observation_id: o.id, mission_id: o.mission_id, kind: o.kind, failure_class: o.failure_class, certainty: o.certainty, component: o.component, release_id: o.release_id, source: o.source, created_at: o.created_at })),
    experiments: gate.experiments.where('1=1').map((e) => ({ experiment_id: e.id, level: e.level, title: e.title, stage: e.stage, decision: e.decision, lineage_id: e.lineage_id, revises: e.revises, holdout_set: e.protocol?.holdout_set ?? null, incumbent_release: e.incumbent_release, release_id: e.release_id, source: e.source, created_at: e.created_at })),
    experiment_metrics: gate.receipts.where('1=1').flatMap((r) => r.comparisons.map((c) => ({ receipt_id: r.receipt_id, experiment_id: r.experiment_id, level: r.level, decision: r.decision, evidence_basis: r.evidence_basis, metric: c.metric, candidate: c.candidate, incumbent: c.incumbent, baseline: c.baseline, diff_vs_incumbent: c.diff_vs_incumbent, ci95_low: c.ci95_vs_incumbent?.[0] ?? null, ci95_high: c.ci95_vs_incumbent?.[1] ?? null, n: c.n, decided_at: r.decided_at }))),
  };
  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(tables)) {
    // One load per table per export point: repeating the export at the same point adds nothing.
    const res = warehouse.load(table, rows, `export:${table}:seq${lastSeq}:n${rows.length}`);
    counts[table] = res.source === 'unavailable' ? -1 : res.rows;
  }
  const dir = warehouse instanceof LocalJsonlWarehouse ? warehouse.dir : join(rt.paths.home, 'export');
  mkdirSync(dir, { recursive: true });
  const schema_path = join(dir, 'schema.json');
  writeFileSync(schema_path, JSON.stringify({ note: 'Field names per table; types follow the JSON values (STRING, INTEGER, FLOAT, BOOLEAN). Null means not measured.', timestamps: ISO, tables: Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, Object.keys(rows[0] ?? {})])) }, null, 2));
  return { tables: counts, schema_path };
}
