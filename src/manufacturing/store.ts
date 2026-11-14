import type { Store } from '../store/store.ts';
import { assert, hashOf } from '../lib/util.ts';
import { parseBatch, parsePrincipal, requireAccess, sourceKey, timestamp } from './schema.ts';
import type { Principal, Snapshot, SourceBatch, SourceRecord, SourceVersion } from './schema.ts';

type VersionRow = { seq: number; dataset_id: string; data_class: SourceBatch['data_class']; source_key: string; record_hash: string; known_from: string; doc: string };
const decode = (r: VersionRow): SourceVersion => ({ sequence: r.seq, dataset_id: r.dataset_id, data_class: r.data_class, source_key: r.source_key, record_hash: r.record_hash, known_from: r.known_from, record: JSON.parse(r.doc) as SourceRecord });

/** Uses the existing runtime DB and event log. Source versions and frozen packets are append-only. */
export class ManufacturingStore {
  store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.tx(() => {
      store.db.exec(`CREATE TABLE IF NOT EXISTS manufacturing_versions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT NOT NULL, data_class TEXT NOT NULL,
        source_key TEXT NOT NULL, revision INTEGER NOT NULL, record_hash TEXT NOT NULL, known_from TEXT NOT NULL,
        doc TEXT NOT NULL, UNIQUE(dataset_id, source_key, revision))`);
      store.db.exec('CREATE INDEX IF NOT EXISTS manufacturing_versions_dataset ON manufacturing_versions(dataset_id, known_from, source_key, revision)');
      for (const table of ['manufacturing_snapshots', 'manufacturing_packets', 'manufacturing_reviews']) {
        store.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
      }
      for (const table of ['manufacturing_versions', 'manufacturing_snapshots', 'manufacturing_packets', 'manufacturing_reviews']) {
        store.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'manufacturing history is immutable'); END`);
        store.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'manufacturing history is immutable'); END`);
      }
    });
  }

  ingest(value: unknown, actor: Principal): { inserted: number; duplicates: number; watermark: number } {
    const batch = parseBatch(value); const principal = parsePrincipal(actor);
    return this.store.db.tx(() => {
      const now = this.store.clock.iso(); timestamp(now);
      const prior = this.store.db.get<VersionRow>('SELECT * FROM manufacturing_versions WHERE dataset_id = ? ORDER BY seq DESC LIMIT 1', batch.dataset_id);
      assert(!prior || prior.data_class === batch.data_class, 'manufacturing_class', 'A dataset cannot change evidence class');
      assert(!prior || prior.known_from <= now, 'manufacturing_clock', 'Knowledge time cannot move backwards');
      let inserted = 0, duplicates = 0;
      for (const record of batch.records) {
        requireAccess(principal, record.access_tags);
        const key = sourceKey(record.source), hash = hashOf(record);
        const current = this.store.db.get<VersionRow>('SELECT * FROM manufacturing_versions WHERE dataset_id = ? AND source_key = ? ORDER BY revision DESC LIMIT 1', batch.dataset_id, key);
        if (current) {
          const old = decode(current).record;
          requireAccess(principal, old.access_tags);
          assert(old.kind === record.kind, 'manufacturing_identity', 'A source object cannot change record kind');
          if (old.kind === 'hardware' && record.kind === 'hardware' && record.payload) {
            const history = this.store.db.all<VersionRow>('SELECT * FROM manufacturing_versions WHERE dataset_id = ? AND source_key = ?', batch.dataset_id, key);
            for (const past of history.map(decode)) {
              if (past.record.kind === 'hardware' && past.record.payload) assert(past.record.payload.id === record.payload.id, 'manufacturing_identity', 'A source identity cannot be reassigned to different hardware');
            }
          }
        }
        const existing = this.store.db.get<VersionRow>('SELECT * FROM manufacturing_versions WHERE dataset_id = ? AND source_key = ? AND revision = ?', batch.dataset_id, key, record.revision);
        if (existing) {
          assert(existing.record_hash === hash, 'manufacturing_revision_conflict', 'Source identity/revision was redelivered with different content');
          duplicates++; continue;
        }
        this.store.db.run('INSERT INTO manufacturing_versions(dataset_id,data_class,source_key,revision,record_hash,known_from,doc) VALUES (?,?,?,?,?,?,?)', batch.dataset_id, batch.data_class, key, record.revision, hash, now, JSON.stringify(record));
        inserted++;
      }
      if (inserted) this.store.emit({ type: 'manufacturing_source_imported', actor_id: principal.id, actor_kind: 'operator', payload: { inserted, data_class: batch.data_class } });
      return { inserted, duplicates, watermark: this.watermark(batch.dataset_id) };
    });
  }

  watermark(dataset: string): number {
    return this.store.db.get<{ n: number }>('SELECT COALESCE(MAX(seq), 0) AS n FROM manufacturing_versions WHERE dataset_id = ?', dataset)!.n;
  }

  private latest(dataset: string, knownAt: string): SourceVersion[] {
    return this.store.db.all<VersionRow>(`SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY source_key ORDER BY revision DESC) AS rank
      FROM manufacturing_versions WHERE dataset_id = ? AND known_from <= ?
    ) WHERE rank = 1 ORDER BY source_key`, dataset, knownAt).map(decode);
  }

  snapshot(dataset: string, actor: Principal, knownAt = this.store.clock.iso()): Snapshot {
    const principal = parsePrincipal(actor); timestamp(knownAt);
    assert(knownAt <= this.store.clock.iso(), 'manufacturing_time', 'Cannot snapshot future knowledge');
    return this.store.db.tx(() => {
      const versions = this.latest(dataset, knownAt);
      assert(versions.length > 0 && versions.length <= 2000, 'manufacturing_scope', 'Snapshot must contain 1–2000 source objects');
      // Never silently filter inaccessible rows into an apparently complete genealogy.
      for (const v of versions) requireAccess(principal, v.record.access_tags);
      const watermark = this.store.db.get<{ n: number }>('SELECT MAX(seq) AS n FROM manufacturing_versions WHERE dataset_id = ? AND known_from <= ?', dataset, knownAt)!.n;
      const body = { dataset_id: dataset, data_class: versions[0]!.data_class, known_at: knownAt, watermark, versions };
      const hash = hashOf(body); const snapshot = { ...body, id: `ms_${hash}`, hash };
      this.checkAccess(snapshot, principal);
      this.insert('manufacturing_snapshots', snapshot.id, snapshot);
      return snapshot;
    });
  }

  readSnapshot(id: string, actor: Principal): Snapshot {
    const s = this.read<Snapshot>('manufacturing_snapshots', id);
    assert(s, 'manufacturing_missing', 'Snapshot not found');
    const { id: unused, hash, ...body } = s;
    assert(hashOf(body) === hash && unused === `ms_${hash}`, 'manufacturing_integrity', 'Snapshot hash mismatch');
    this.checkAccess(s, parsePrincipal(actor)); return s;
  }

  private checkAccess(s: Snapshot, actor: Principal): void {
    const current = new Map(this.latest(s.dataset_id, this.store.clock.iso()).map(v => [v.source_key, v]));
    for (const v of s.versions) {
      requireAccess(actor, v.record.access_tags);
      const latest = current.get(v.source_key);
      assert(latest, 'manufacturing_integrity', 'Source history missing');
      // Revoked entitlements apply even to older saved packets.
      requireAccess(actor, latest.record.access_tags);
    }
  }

  insert(table: 'manufacturing_snapshots' | 'manufacturing_packets' | 'manufacturing_reviews', id: string, value: unknown): void {
    const old = this.read<unknown>(table, id);
    if (old !== undefined) { assert(hashOf(old) === hashOf(value), 'manufacturing_integrity', 'Immutable object changed'); return; }
    this.store.db.run(`INSERT INTO ${table}(id,doc) VALUES (?,?)`, id, JSON.stringify(value));
  }
  read<T>(table: 'manufacturing_snapshots' | 'manufacturing_packets' | 'manufacturing_reviews', id: string): T | undefined {
    const row = this.store.db.get<{ doc: string }>(`SELECT doc FROM ${table} WHERE id = ?`, id);
    return row ? JSON.parse(row.doc) as T : undefined;
  }
  reviews<T extends { packet_id: string }>(packetId: string): T[] {
    return this.store.db.all<{ doc: string }>('SELECT doc FROM manufacturing_reviews ORDER BY id').map(r => JSON.parse(r.doc) as T).filter(r => r.packet_id === packetId);
  }
}
