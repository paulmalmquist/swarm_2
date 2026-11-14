import type {
  ActorKind,
  Agent,
  Artifact,
  ArtifactVersion,
  Attempt,
  Decision,
  Draft,
  Evidence,
  Handoff,
  IntakeRequest,
  Memory,
  Message,
  Mission,
  Observation,
  Outcome,
  RunEvent,
  StakeholderNeed,
  Swarm,
  Task,
  Verification,
} from '../contracts/types.ts';
import type { BudgetAccount, ExternalEffect, IntegrationItem } from '../contracts/runtime.ts';
import { type Clock, SwarmError, hashOf, newId, sha256, systemClock, canonicalize } from '../lib/util.ts';
import { Db, Repo } from './db.ts';

export interface EmitInput {
  type: string;
  mission_id?: string | null;
  task_id?: string | null;
  actor_id: string;
  actor_kind: ActorKind;
  payload?: Record<string, unknown>;
  idempotency_key?: string | null;
  release_id?: string | null;
}

export class Store {
  db: Db;
  clock: Clock;

  missions: Repo<Mission>;
  tasks: Repo<Task>;
  attempts: Repo<Attempt>;
  swarms: Repo<Swarm>;
  agents: Repo<Agent>;
  artifacts: Repo<Artifact>;
  versions: Repo<ArtifactVersion>;
  evidence: Repo<Evidence>;
  verifications: Repo<Verification>;
  handoffs: Repo<Handoff>;
  messages: Repo<Message>;
  decisions: Repo<Decision>;
  drafts: Repo<Draft>;
  requests: Repo<IntakeRequest>;
  needs: Repo<StakeholderNeed>;
  memories: Repo<Memory>;
  outcomes: Repo<Outcome>;
  observations: Repo<Observation>;
  accounts: Repo<BudgetAccount>;
  integration: Repo<IntegrationItem>;
  effects: Repo<ExternalEffect>;

  constructor(path: string, clock: Clock = systemClock) {
    this.db = new Db(path);
    this.clock = clock;
    const d = this.db;
    this.missions = new Repo(d, 'missions', ['status', 'priority', 'release_id', 'created_at']);
    this.tasks = new Repo(d, 'tasks', [
      'mission_id',
      'parent_task_id',
      'swarm_id',
      'key',
      'status',
      'executor',
      'owner_id',
      'lease_expires_at',
      'priority',
      'currency',
      'competing_group',
      'scope_signature',
    ]);
    this.attempts = new Repo(d, 'attempts', ['task_id', 'mission_id', 'attempt_no', 'status', 'pid', 'provider', 'provider_mode']);
    this.swarms = new Repo(d, 'swarms', ['mission_id', 'parent_swarm_id', 'archetype', 'status']);
    this.agents = new Repo(d, 'agents', ['mission_id', 'swarm_id', 'archetype', 'role']);
    this.artifacts = new Repo(d, 'artifacts', ['mission_id', 'key']);
    this.versions = new Repo(d, 'artifact_versions', [
      'artifact_id',
      'mission_id',
      'key',
      'version_no',
      'content_hash',
      'currency',
      'produced_by_task_id',
      'release_id',
    ]);
    this.evidence = new Repo(d, 'evidence', ['mission_id', 'task_id', 'kind']);
    this.verifications = new Repo(d, 'verifications', ['mission_id', 'task_id', 'criterion_id', 'verdict', 'generation']);
    this.handoffs = new Repo(d, 'handoffs', ['mission_id', 'task_id', 'status', 'to_owner']);
    this.messages = new Repo(d, 'messages', ['mission_id', 'task_id', 'to', 'kind', 'status']);
    this.decisions = new Repo(d, 'decisions', ['mission_id', 'task_id', 'status', 'owner_id', 'owner_kind', 'requires_human', 'kind']);
    this.drafts = new Repo(d, 'drafts', ['mission_id', 'status', 'kind']);
    this.requests = new Repo(d, 'requests', ['cluster_id', 'mission_id', 'data_class']);
    this.needs = new Repo(d, 'stakeholder_needs', ['request_id', 'mission_id', 'status']);
    this.memories = new Repo(d, 'memories', ['kind', 'status', 'certainty']);
    this.outcomes = new Repo(d, 'outcomes', ['mission_id', 'task_id', 'release_id', 'verified_success']);
    this.observations = new Repo(d, 'observations', ['mission_id', 'kind', 'failure_class', 'release_id', 'component']);
    this.accounts = new Repo(d, 'budget_accounts', ['parent_id', 'mission_id', 'class', 'status']);
    this.integration = new Repo(d, 'integration_queue', ['mission_id', 'task_id', 'integrator_task_id', 'status', 'position']);
    this.effects = new Repo(d, 'external_effects', ['adapter', 'idempotency_key', 'status']);
    this.init();
  }

  private repos(): Repo<{ id: string }>[] {
    return [
      this.missions,
      this.tasks,
      this.attempts,
      this.swarms,
      this.agents,
      this.artifacts,
      this.versions,
      this.evidence,
      this.verifications,
      this.handoffs,
      this.messages,
      this.decisions,
      this.drafts,
      this.requests,
      this.needs,
      this.memories,
      this.outcomes,
      this.observations,
      this.accounts,
      this.integration,
      this.effects,
    ] as unknown as Repo<{ id: string }>[];
  }

  private init(): void {
    const d = this.db;
    d.tx(() => {
      for (const r of this.repos()) d.exec(r.ddl());
      d.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      d.exec(`CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL,
        mission_id TEXT, task_id TEXT, actor_id TEXT NOT NULL, actor_kind TEXT NOT NULL, idempotency_key TEXT,
        payload TEXT NOT NULL, release_id TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL)`);
      // The event log is append-only: state changes and their events commit in one transaction.
      d.exec(`CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END`);
      d.exec(`CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END`);
      d.exec(`CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, scope TEXT NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL)`);
      d.exec(`CREATE TABLE IF NOT EXISTS task_deps (task_id TEXT NOT NULL, depends_on TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (task_id, depends_on))`);
      d.exec(`CREATE TABLE IF NOT EXISTS task_inputs (task_id TEXT NOT NULL, artifact_key TEXT NOT NULL, version_id TEXT NOT NULL, PRIMARY KEY (task_id, artifact_key))`);
      d.exec(`CREATE TABLE IF NOT EXISTS budget_ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, kind TEXT NOT NULL, amounts TEXT NOT NULL, ref TEXT, ts TEXT NOT NULL)`);
      d.exec(`CREATE TABLE IF NOT EXISTS active_calls (attempt_id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, started_at TEXT NOT NULL)`);
      d.exec(`CREATE TABLE IF NOT EXISTS subscriptions (topic TEXT NOT NULL, subscriber_id TEXT NOT NULL, mission_id TEXT NOT NULL, PRIMARY KEY (topic, subscriber_id, mission_id))`);
      for (const [table, col] of [
        ['tasks', 'mission_id'],
        ['tasks', 'status'],
        ['tasks', 'parent_task_id'],
        ['attempts', 'task_id'],
        ['attempts', 'status'],
        ['artifact_versions', 'artifact_id'],
        ['artifact_versions', 'mission_id'],
        ['verifications', 'task_id'],
        ['events', 'mission_id'],
        ['events', 'type'],
        ['messages', 'mission_id'],
        ['decisions', 'status'],
        ['observations', 'failure_class'],
        ['budget_accounts', 'parent_id'],
      ] as const) {
        d.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_${col} ON "${table}" ("${col}")`);
      }
      d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_artifacts_key ON artifacts (mission_id, key)`);
      d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_key ON tasks (mission_id, key)`);
    });
  }

  // ───────── meta ─────────

  getMeta<T>(key: string): T | undefined {
    const row = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key);
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setMeta(key: string, value: unknown): void {
    this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  // ───────── events ─────────

  emit(e: EmitInput): RunEvent {
    return this.db.tx(() => {
      const last = this.db.get<{ hash: string }>('SELECT hash FROM events ORDER BY seq DESC LIMIT 1');
      const prev = last?.hash ?? 'genesis';
      const event_id = newId('evt');
      const ts = this.clock.iso();
      const payload = e.payload ?? {};
      const body = {
        event_id,
        ts,
        type: e.type,
        mission_id: e.mission_id ?? null,
        task_id: e.task_id ?? null,
        actor_id: e.actor_id,
        actor_kind: e.actor_kind,
        payload,
      };
      const hash = sha256(prev + canonicalize(body));
      const r = this.db.run(
        `INSERT INTO events (event_id, ts, type, mission_id, task_id, actor_id, actor_kind, idempotency_key, payload, release_id, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        event_id,
        ts,
        e.type,
        body.mission_id,
        body.task_id,
        e.actor_id,
        e.actor_kind,
        e.idempotency_key ?? null,
        JSON.stringify(payload),
        e.release_id ?? null,
        prev,
        hash,
      );
      return { seq: r.lastInsertRowid, ...body, idempotency_key: e.idempotency_key ?? null, release_id: e.release_id ?? null, prev_hash: prev, hash };
    });
  }

  events(opts: { mission_id?: string; task_id?: string; type?: string; after_seq?: number; limit?: number } = {}): RunEvent[] {
    const where: string[] = ['seq > ?'];
    const params: (string | number)[] = [opts.after_seq ?? 0];
    if (opts.mission_id) {
      where.push('mission_id = ?');
      params.push(opts.mission_id);
    }
    if (opts.task_id) {
      where.push('task_id = ?');
      params.push(opts.task_id);
    }
    if (opts.type) {
      where.push('type = ?');
      params.push(opts.type);
    }
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT ?`,
      ...params,
      opts.limit ?? 100000,
    );
    return rows.map((r) => ({ ...(r as unknown as RunEvent), seq: Number(r.seq), payload: JSON.parse(r.payload as string) as Record<string, unknown> }));
  }

  /** Recompute the hash chain. Local hashes detect inconsistency; they are not a tamper-proof audit service. */
  verifyEventChain(): { ok: boolean; count: number; broken_at: number | null } {
    let prev = 'genesis';
    let count = 0;
    for (const e of this.events()) {
      const body = {
        event_id: e.event_id,
        ts: e.ts,
        type: e.type,
        mission_id: e.mission_id,
        task_id: e.task_id,
        actor_id: e.actor_id,
        actor_kind: e.actor_kind,
        payload: e.payload,
      };
      if (e.prev_hash !== prev || e.hash !== sha256(prev + canonicalize(body))) return { ok: false, count, broken_at: e.seq };
      prev = e.hash;
      count++;
    }
    return { ok: true, count, broken_at: null };
  }

  // ───────── idempotency ─────────

  /**
   * Run `fn` once per key. A repeated key with the same canonical body returns the first result.
   * A repeated key with a different body is quarantined as a conflict and never applied.
   */
  idempotent<T>(key: string, scope: string, body: unknown, fn: () => T): { result: T; replayed: boolean } {
    const request_hash = hashOf(body);
    try {
      return this.db.tx(() => {
        const row = this.db.get<{ request_hash: string; response: string }>('SELECT request_hash, response FROM idempotency WHERE key = ?', key);
        if (row) {
          if (row.request_hash !== request_hash) throw new SwarmError('idempotency_conflict', `Idempotency key ${key} was reused with a different body`, { key, scope });
          this.emit({ type: 'duplicate_delivery_ignored', actor_id: 'runtime', actor_kind: 'runtime', payload: { key, scope }, idempotency_key: key });
          return { result: JSON.parse(row.response) as T, replayed: true };
        }
        const result = fn();
        this.db.run('INSERT INTO idempotency (key, scope, request_hash, response, created_at) VALUES (?, ?, ?, ?, ?)', key, scope, request_hash, JSON.stringify(result ?? null), this.clock.iso());
        return { result, replayed: false };
      });
    } catch (err) {
      if (err instanceof SwarmError && err.code === 'idempotency_conflict') {
        // Recorded outside the rolled-back transaction so the quarantine itself is durable.
        this.emit({ type: 'idempotency_conflict_quarantined', actor_id: 'runtime', actor_kind: 'runtime', payload: { key, scope }, idempotency_key: key });
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
