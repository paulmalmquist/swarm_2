import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store/store.ts';
import { ManualClock, hashOf } from '../src/lib/util.ts';
import { ManufacturingInvestigations, packetMarkdown } from '../src/manufacturing/investigation.ts';
import { compareHardware } from '../src/manufacturing/evaluation.ts';
import { parseBatch, parsePolicy, parsePrincipal, parseRequest, sourceKey } from '../src/manufacturing/schema.ts';
import type { SourceBatch, SourceIdentity, SourceRecord } from '../src/manufacturing/schema.ts';

const fixture = resolve('fixtures/manufacturing/anomaly');
const json = (name: string): unknown => JSON.parse(readFileSync(join(fixture, name + '.json'), 'utf8')) as unknown;
const ref = (id: string, type = 'hardware', system = 'syn-mes'): SourceIdentity => ({ system, type, native_id: id });
const requiredIds = ['SYN-MAT-L17', 'SYN-SN008', 'SYN-SN009', 'SYN-SN010', 'SYN-ASM-020', 'SYN-ASM-021', 'SYN-ASM-022'];
function setup() {
  const clock = new ManualClock(), store = new Store(':memory:', clock);
  const batch = parseBatch(json('sources')), request = parseRequest(json('request')), policy = parsePolicy(json('policy')), principal = parsePrincipal(json('principal'));
  const m = new ManufacturingInvestigations(store, policy);
  m.repository.ingest(batch, principal);
  return { clock, store, batch, request, policy, principal, m };
}
function record(batch: SourceBatch, id: string): SourceRecord { return structuredClone(batch.records.find(r => r.source.native_id === id)!); }
function correction(batch: SourceBatch, id: string): SourceRecord { const r = record(batch, id); r.revision++; return r; }

test('manufacturing traces the lot, historical installations and unknown identities without a model', () => {
  const s = setup(); try {
    const p = s.m.investigate(s.request, s.principal).packet;
    const evaluation = compareHardware(p, { required_ids: requiredIds, expected_unknown_keys: ['SYN-SN010', `unresolved:${sourceKey(ref('SYN-SN011'))}`] });
    assert.equal(evaluation.matches_reference, true, JSON.stringify(evaluation));
    assert.ok(p.impact.candidates.find(c => c.hardware_id === 'SYN-ASM-020')!.paths[0]!.some(p => p.valid_to === '2026-11-05T00:00:00.000Z'));
    assert.deepEqual(p.impact.unassessed_hardware, ['SYN-MAT-L03', 'SYN-REF-077']);
    assert.equal(p.impact.not_found_means_unaffected, false);
    assert.equal(p.authorizes_hardware_action, false);
    assert.ok(p.impact.candidates.find(c => c.hardware_id === 'SYN-SN008')!.is_finding_subject);
    assert.match(packetMarkdown(s.m.packet(p.id, s.principal)), /does not authorize/);
  } finally { s.store.close(); }
});

test('manufacturing joins temporal paths only when all relationships coexist', () => {
  const s = setup(); try {
    const hardware = record(s.batch, 'SYN-ASM-021');
    assert.ok(hardware.kind === 'hardware' && hardware.payload); hardware.source.native_id = 'SYN-ARTICLE'; hardware.payload.id = 'SYN-ARTICLE'; hardware.payload.hardware_kind = 'article';
    const edge = record(s.batch, 'SYN-INSTALL-008-021');
    assert.ok(edge.kind === 'relationship' && edge.payload); edge.source.native_id = 'SYN-NONCOEXISTENT'; edge.payload.from = ref('SYN-ASM-021'); edge.payload.to = ref('SYN-ARTICLE');
    edge.valid_from = '2026-11-01T00:00:00.000Z'; edge.valid_to = '2026-11-04T00:00:00.000Z';
    s.m.repository.ingest({ ...s.batch, records: [hardware, edge] }, s.principal);
    const p = s.m.investigate(s.request, s.principal).packet;
    assert.ok(p.impact.unassessed_hardware.includes('SYN-ARTICLE'), 'individually overlapping edges must not invent a coexisting installation path');
  } finally { s.store.close(); }
});

test('manufacturing evidence retains conflicts, partial coverage and qualification/acceptance separation', () => {
  const s = setup(); try {
    const p = s.m.investigate(s.request, s.principal).packet;
    const conflicted = p.configuration.find(c => c.hardware_id === 'SYN-SN009')!.dimensions.find(d => d.dimension === 'process')!;
    assert.equal(conflicted.state, 'disputed'); assert.equal(conflicted.source_hashes.length, 2);
    const qt = p.evidence.filter(e => e.evidence_class === 'qualification');
    assert.ok(qt.length && qt.every(e => e.status === 'class_mismatch' && e.coverage === 'none'));
    const partial = p.evidence.find(e => e.target_hardware_id === 'SYN-SN008' && e.evidence_class === 'acceptance')!;
    assert.equal(partial.coverage, 'partial'); assert.equal(partial.status, 'unknown');
    assert.ok(p.evidence.every(e => !e.supports_acceptance));
    const complete = correction(s.batch, 'SYN-AT-008');
    assert.ok(complete.kind === 'evidence' && complete.payload);
    complete.payload.configuration = { process: 'SYN-PS-12 Rev C', material_lot: 'SYN-MAT-L17', design_revision: 'SYN-PART-441 Rev A' };
    s.clock.advance(1000); s.m.repository.ingest({ ...s.batch, records: [complete] }, s.principal);
    const exact = s.m.investigate(s.request, s.principal).packet.evidence.find(e => e.target_hardware_id === 'SYN-SN008' && e.evidence_class === 'acceptance')!;
    assert.equal(exact.status, 'candidate_for_review'); assert.equal(exact.coverage, 'full'); assert.equal(exact.supports_acceptance, false);
  } finally { s.store.close(); }
});

test('manufacturing source replay is idempotent and revision conflicts roll back the whole import', () => {
  const s = setup(); try {
    const p = s.m.investigate(s.request, s.principal).packet;
    const wm = s.m.repository.watermark(s.batch.dataset_id);
    assert.equal(s.m.repository.ingest(s.batch, s.principal).inserted, 0);
    assert.equal(s.m.investigate(s.request, s.principal).packet.hash, p.hash);
    const newRecord = correction(s.batch, 'SYN-AT-008');
    const conflict = record(s.batch, 'SYN-NCR-1042'); assert.ok(conflict.kind === 'finding' && conflict.payload); conflict.payload.description = 'Changed without a revision';
    assert.throws(() => s.m.repository.ingest({ ...s.batch, records: [newRecord, conflict] }, s.principal), /different content/);
    assert.equal(s.m.repository.watermark(s.batch.dataset_id), wm);
    assert.equal(s.m.packet(p.id, s.principal).currency, 'current');
  } finally { s.store.close(); }
});

test('manufacturing two clocks preserve past knowledge and prevent old revisions from replacing newer ones', () => {
  const s = setup(); try {
    const originalTime = s.clock.iso();
    const original = s.m.investigate(s.request, s.principal).packet;
    const latest = correction(s.batch, 'SYN-CONTRARY-009'); latest.revision = 3;
    assert.ok(latest.kind === 'configuration' && latest.payload); latest.payload.value = 'SYN-PS-12 Rev C';
    s.clock.advance(1000); s.m.repository.ingest({ ...s.batch, records: [latest] }, s.principal);
    const old = correction(s.batch, 'SYN-CONTRARY-009');
    s.clock.advance(1000); s.m.repository.ingest({ ...s.batch, records: [old] }, s.principal);
    const fresh = s.m.investigate(s.request, s.principal).packet;
    assert.equal(fresh.configuration.find(c => c.hardware_id === 'SYN-SN009')!.dimensions[0]!.state, 'known');
    const historical = s.m.investigate({ ...s.request, known_at: originalTime }, s.principal);
    assert.deepEqual(historical.packet.configuration, original.configuration);
    assert.equal(historical.currency, 'stale');
    assert.equal(s.m.sourceBundle(fresh.id, s.principal).versions.find(v => v.record.source.native_id === 'SYN-CONTRARY-009')!.record.revision, 3);
  } finally { s.store.close(); }
});

test('manufacturing reviews bind exact packet, role and current source set, including newly discovered siblings', () => {
  const s = setup(); try {
    const p = s.m.investigate(s.request, s.principal).packet;
    assert.throws(() => s.m.review(p.id, p.hash, 'acknowledged', 'Read', { ...s.principal, id: 'unassigned' }), /No engineering/);
    assert.throws(() => s.m.review(p.id, 'wrong', 'acknowledged', 'Read', s.principal), /exact packet/);
    assert.throws(() => s.m.review(p.id, p.hash, 'approve' as 'acknowledged', 'Release', s.principal), /cannot authorize/);
    assert.equal(s.m.review(p.id, p.hash, 'acknowledged', 'Synthetic review', s.principal).reviews[0]!.current, true);
    assert.equal(s.m.review(p.id, p.hash, 'acknowledged', 'Synthetic review', s.principal).reviews.length, 1);
    const added = record(s.batch, 'SYN-REF-077'); added.source.native_id = 'SYN-NEW'; assert.ok(added.kind === 'hardware' && added.payload); added.payload.id = 'SYN-NEW';
    s.clock.advance(1000); s.m.repository.ingest({ ...s.batch, records: [added] }, s.principal);
    const stale = s.m.packet(p.id, s.principal);
    assert.equal(stale.currency, 'stale'); assert.equal(stale.reviews[0]!.current, false);
    assert.equal(stale.reviews[0]!.authorizes_hardware_action, false);
    assert.throws(() => s.m.review(p.id, p.hash, 'acknowledged', 'Again', s.principal), /changed/);
    const fresh = s.m.investigate(s.request, s.principal); assert.equal(fresh.reviews.length, 0);
  } finally { s.store.close(); }
});

test('manufacturing policy changes invalidate reviews and missing authority never becomes a known configuration', () => {
  const s = setup(); try {
    const p = s.m.investigate(s.request, s.principal).packet;
    s.m.review(p.id, p.hash, 'acknowledged', 'Synthetic', s.principal);
    const revised = new ManufacturingInvestigations(s.store, { ...s.policy, revision: 2, configuration_authorities: [] });
    assert.equal(revised.packet(p.id, s.principal).reviews[0]!.current, false);
    const fresh = revised.investigate(s.request, s.principal);
    assert.equal(fresh.packet.configuration.find(c => c.hardware_id === 'SYN-SN008')!.dimensions[0]!.state, 'unauthorized_source');
  } finally { s.store.close(); }
});

test('manufacturing ACLs fail closed for partial snapshots and revocation also protects saved packets and sources', () => {
  const s = setup(); try {
    const p = s.m.investigate(s.request, s.principal).packet;
    assert.throws(() => s.m.investigate(s.request, { id: 'other', entitlements: ['different'] }), /Source access denied/);
    const restricted = correction(s.batch, 'SYN-CONTRARY-009'); restricted.access_tags = ['restricted'];
    s.clock.advance(1000);
    s.m.repository.ingest({ ...s.batch, records: [restricted] }, { ...s.principal, entitlements: [...s.principal.entitlements, 'restricted'] });
    for (const call of [() => s.m.packet(p.id, s.principal), () => s.m.sourceBundle(p.id, s.principal), () => s.m.investigate(s.request, s.principal)]) assert.throws(call, /Source access denied/);
  } finally { s.store.close(); }
});

test('manufacturing ambiguous aliases never merge hardware or produce a definitive relationship', () => {
  const s = setup(); try {
    const ambiguous = correction(s.batch, 'SYN-SN009'); assert.ok(ambiguous.kind === 'hardware' && ambiguous.payload); ambiguous.payload.aliases = [ref('SYN-SN008')];
    s.m.repository.ingest({ ...s.batch, records: [ambiguous] }, s.principal);
    const p = s.m.investigate(s.request, s.principal).packet;
    assert.ok(p.impact.candidates.some(c => c.hardware_id === null && c.status === 'unknown' && c.is_finding_subject));
    assert.ok(p.impact.issues.some(i => i.code === 'identity_ambiguous'));
    assert.equal(p.impact.candidates.find(c => c.hardware_id === 'SYN-ASM-021')!.status, 'unknown');
  } finally { s.store.close(); }
});

test('manufacturing withdrawal removes evidence from new packets but preserves frozen historical evidence', () => {
  const s = setup(); try {
    const p = s.m.investigate(s.request, s.principal).packet;
    const withdrawn = correction(s.batch, 'SYN-QT-77'); withdrawn.withdrawn = true; withdrawn.payload = null;
    s.clock.advance(1000); s.m.repository.ingest({ ...s.batch, records: [withdrawn] }, s.principal);
    assert.ok(s.m.packet(p.id, s.principal).packet.evidence.some(e => e.evidence_class === 'qualification'));
    assert.ok(s.m.investigate(s.request, s.principal).packet.evidence.every(e => e.evidence_class !== 'qualification'));
    assert.equal(s.m.packet(p.id, s.principal).currency, 'stale');
  } finally { s.store.close(); }
});

test('manufacturing supplied reference detects a wrong source edge; engine does not claim source truth', () => {
  const s = setup(); try {
    const wrong = record(s.batch, 'SYN-LOT-LINK-008'); wrong.source.native_id = 'SYN-WRONG-LINK'; assert.ok(wrong.kind === 'relationship' && wrong.payload); wrong.payload.from = ref('SYN-REF-077');
    s.m.repository.ingest({ ...s.batch, records: [wrong] }, s.principal);
    const p = s.m.investigate(s.request, s.principal).packet;
    const evaluation = compareHardware(p, { required_ids: requiredIds, expected_unknown_keys: [] });
    assert.equal(evaluation.matches_reference, false);
    assert.deepEqual(evaluation.extra_candidates, ['SYN-REF-077']);
    assert.equal(p.impact.coverage, 'not_established');
  } finally { s.store.close(); }
});

test('manufacturing rejects malformed schemas, data-class mixing, future knowledge and mutable history', () => {
  const s = setup(); try {
    for (const patch of [{ revision: 0 }, { valid_from: 'yesterday' }, { access_tags: [] }, { disposition: 'approved' }, { withdrawn: true }]) {
      assert.throws(() => parseBatch({ ...s.batch, records: [{ ...s.batch.records[0], ...patch }] }));
    }
    assert.throws(() => s.m.repository.ingest({ ...s.batch, data_class: 'real' }, s.principal), /evidence class/);
    assert.throws(() => s.m.investigate({ ...s.request, known_at: '2099-01-01T00:00:00.000Z' }, s.principal), /future knowledge/);
    const p = s.m.investigate(s.request, s.principal).packet;
    assert.throws(() => s.store.db.run('UPDATE manufacturing_packets SET doc = ? WHERE id = ?', '{}', p.id), /immutable/);
    assert.throws(() => s.store.db.run('DELETE FROM manufacturing_versions'), /immutable/);
    const revised = correction(s.batch, 'SYN-SN008'); assert.ok(revised.kind === 'hardware' && revised.payload); revised.payload.id = 'OTHER';
    assert.throws(() => s.m.repository.ingest({ ...s.batch, records: [revised] }, s.principal), /reassigned/);
  } finally { s.store.close(); }
});

test('manufacturing CLI imports, investigates and reproduces saved packets across process restarts', () => {
  const home = mkdtempSync(join(tmpdir(), 'swarm-manufacturing-'));
  const cli = (cmd: string, value: string, extra: string[] = []): string => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli.ts', 'manufacturing', cmd, value, '--home', home, '--policy', join(fixture, 'policy.json'), '--principal', join(fixture, 'principal.json'), ...extra], { encoding: 'utf8', timeout: 20_000 });
  try {
    assert.ok(JSON.parse(cli('ingest', join(fixture, 'sources.json'))).inserted > 0);
    const first = JSON.parse(cli('investigate', join(fixture, 'request.json')));
    const saved = JSON.parse(cli('packet', first.packet.id));
    assert.equal(hashOf(saved), hashOf(first));
    assert.match(cli('packet', first.packet.id, ['--md']), /SYN-SN011/);
    const sources = JSON.parse(cli('sources', first.packet.id)); assert.equal(sources.hash, first.packet.manifest.snapshot_hash);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('manufacturing genealogy cycles terminate with an explicit uncertainty', () => {
  const s = setup(); try {
    const a = record(s.batch, 'SYN-LOT-LINK-008'), b = record(s.batch, 'SYN-LOT-LINK-009');
    assert.ok(a.kind === 'relationship' && a.payload && b.kind === 'relationship' && b.payload);
    a.source.native_id = 'SYN-CYCLE-A'; b.source.native_id = 'SYN-CYCLE-B';
    a.payload = { from: ref('SYN-MAT-L03'), to: ref('SYN-MAT-L17'), relationship: 'split_from' };
    b.payload = { from: ref('SYN-MAT-L17'), to: ref('SYN-MAT-L03'), relationship: 'split_from' };
    s.m.repository.ingest({ ...s.batch, records: [a, b] }, s.principal);
    assert.ok(s.m.investigate(s.request, s.principal).packet.impact.issues.some(i => i.code === 'genealogy_cycle'));
  } finally { s.store.close(); }
});

test('manufacturing tombstones cannot be used to reassign a source identity', () => {
  const s = setup(); try {
    const removed = correction(s.batch, 'SYN-SN008'); removed.withdrawn = true; removed.payload = null;
    s.clock.advance(1000); s.m.repository.ingest({ ...s.batch, records: [removed] }, s.principal);
    const replacement = correction(s.batch, 'SYN-SN008'); replacement.revision = 3;
    assert.ok(replacement.kind === 'hardware' && replacement.payload); replacement.payload.id = 'DIFFERENT-SERIAL';
    assert.throws(() => s.m.repository.ingest({ ...s.batch, records: [replacement] }, s.principal), /reassigned/);
  } finally { s.store.close(); }
});

test('manufacturing expired evidence is not counted as configuration coverage', () => {
  const s = setup(); try {
    const expired = correction(s.batch, 'SYN-AT-008'); expired.valid_to = '2026-11-08T00:00:00.000Z';
    s.clock.advance(1000); s.m.repository.ingest({ ...s.batch, records: [expired] }, s.principal);
    const p = s.m.investigate(s.request, s.principal).packet;
    const e = p.evidence.find(e => e.target_hardware_id === 'SYN-SN008' && e.evidence_class === 'acceptance')!;
    assert.equal(e.status, 'unknown'); assert.equal(e.coverage, 'none');
  } finally { s.store.close(); }
});

test('manufacturing saved review cannot stay current after analysis code changes', () => {
  const s = setup(); try {
    const original = s.m.investigate(s.request, s.principal).packet;
    const { id: unusedId, hash: unusedHash, ...body } = structuredClone(original);
    // Simulate a packet captured by a prior deployment with the same version label.
    body.manifest.engine_hash = 'prior-deployment-code';
    const hash = hashOf(body), prior = { ...body, hash, id: `mp_${hash}` };
    s.m.repository.insert('manufacturing_packets', prior.id, prior);
    assert.deepEqual(s.m.packet(prior.id, s.principal).stale_reasons, ['analysis_rules_changed']);
    assert.throws(() => s.m.review(prior.id, prior.hash, 'acknowledged', 'Read', s.principal), /changed/);
  } finally { s.store.close(); }
});
