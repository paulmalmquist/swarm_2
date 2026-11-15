import { recordsOf, sourceKey } from './schema.ts';
import type { Hardware, Snapshot, SourceIdentity, SourceVersion } from './schema.ts';

export type Resolution = { status: 'resolved'; hardware: Hardware; source: SourceVersion } | { status: 'missing' | 'ambiguous'; candidate_ids: string[] };

/** Exact source keys only. No label, serial-string or vector-similarity matching. */
export class IdentityIndex {
  private aliases = new Map<string, { hardware: Hardware; source: SourceVersion }[]>();
  private ids = new Map<string, number>();
  constructor(snapshot: Snapshot) {
    for (const v of recordsOf(snapshot, 'hardware')) {
      const hardware = v.record.payload;
      this.ids.set(hardware.id, (this.ids.get(hardware.id) ?? 0) + 1);
      for (const key of new Set([v.record.source, ...hardware.aliases].map(sourceKey))) {
        this.aliases.set(key, [...(this.aliases.get(key) ?? []), { hardware, source: v }]);
      }
    }
  }
  resolve(ref: SourceIdentity): Resolution {
    const candidates = this.aliases.get(sourceKey(ref)) ?? [];
    if (candidates.length === 1 && this.ids.get(candidates[0]!.hardware.id) === 1) return { status: 'resolved', ...candidates[0]! };
    return { status: candidates.length ? 'ambiguous' : 'missing', candidate_ids: [...new Set(candidates.map(c => c.hardware.id))].sort() };
  }
}
