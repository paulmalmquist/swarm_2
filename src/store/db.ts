import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type Scalar = string | number | bigint | null | Uint8Array;

/**
 * Thin wrapper over the built-in SQLite driver.
 * SQLite is authoritative for ownership, task state, handoffs and approvals;
 * artifact content lives in files; any retrieval index is a rebuildable aid.
 */
export class Db {
  raw: DatabaseSync;
  path: string;
  private depth = 0;
  private deferred: (() => void)[] = [];

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA busy_timeout = 8000');
    this.raw.exec('PRAGMA foreign_keys = ON');
  }

  get inTransaction(): boolean { return this.depth > 0; }

  /** Run `fn` atomically. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.raw.exec('COMMIT');
      this.flush();
      return out;
    } catch (err) {
      this.depth--;
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* the original error matters more */
      }
      this.flush();
      throw err;
    }
  }

  /**
   * Run `fn` once the outermost transaction has ended, whether it committed or rolled back.
   * Used for records that must survive the failure they describe.
   */
  afterTx(fn: () => void): void {
    if (this.depth === 0) fn();
    else this.deferred.push(fn);
  }

  private flush(): void {
    const pending = this.deferred;
    this.deferred = [];
    for (const fn of pending) {
      try {
        fn();
      } catch {
        /* a failed after-commit record must not mask the original outcome */
      }
    }
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  run(sql: string, ...params: Scalar[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Record<string, unknown>>(sql: string, ...params: Scalar[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: Scalar[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  close(): void {
    this.raw.close();
  }
}

function scalar(v: unknown): Scalar {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') return v;
  return JSON.stringify(v);
}

/**
 * A document table: the full record is stored as JSON in `doc`, and a few fields are
 * mirrored into indexed columns for querying. Records are always written whole.
 */
export class Repo<T extends { id: string }> {
  private db: Db;
  name: string;
  cols: string[];

  constructor(db: Db, name: string, cols: string[]) {
    this.db = db;
    this.name = name;
    this.cols = cols;
  }

  ddl(): string {
    const cols = this.cols.map((c) => `"${c}"`).join(', ');
    return `CREATE TABLE IF NOT EXISTS "${this.name}" ("id" TEXT PRIMARY KEY${cols ? ', ' + cols : ''}, "doc" TEXT NOT NULL)`;
  }

  put(rec: T): T {
    const names = ['id', ...this.cols, 'doc'];
    const values: Scalar[] = [rec.id, ...this.cols.map((c) => scalar((rec as Record<string, unknown>)[c])), JSON.stringify(rec)];
    const updates = [...this.cols, 'doc'].map((c) => `"${c}" = excluded."${c}"`).join(', ');
    this.db.run(
      `INSERT INTO "${this.name}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})
       ON CONFLICT("id") DO UPDATE SET ${updates}`,
      ...values,
    );
    return rec;
  }

  get(id: string): T | undefined {
    const row = this.db.get<{ doc: string }>(`SELECT "doc" FROM "${this.name}" WHERE "id" = ?`, id);
    return row ? (JSON.parse(row.doc) as T) : undefined;
  }

  must(id: string): T {
    const rec = this.get(id);
    if (!rec) throw new Error(`${this.name} ${id} not found`);
    return rec;
  }

  where(clause = '1=1', ...params: Scalar[]): T[] {
    return this.db
      .all<{ doc: string }>(`SELECT "doc" FROM "${this.name}" WHERE ${clause}`, ...params)
      .map((r) => JSON.parse(r.doc) as T);
  }

  first(clause: string, ...params: Scalar[]): T | undefined {
    return this.where(`${clause} LIMIT 1`, ...params)[0];
  }

  count(clause = '1=1', ...params: Scalar[]): number {
    return Number(this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${this.name}" WHERE ${clause}`, ...params)?.n ?? 0);
  }

  delete(id: string): void {
    this.db.run(`DELETE FROM "${this.name}" WHERE "id" = ?`, id);
  }
}
