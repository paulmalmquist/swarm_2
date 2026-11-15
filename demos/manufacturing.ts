import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openRuntime } from '../src/runtime.ts';
import { ManualClock, assert } from '../src/lib/util.ts';
import { ManufacturingInvestigations, packetMarkdown } from '../src/manufacturing/investigation.ts';
import { compareHardware } from '../src/manufacturing/evaluation.ts';
import { parseBatch, parsePrincipal, parseRequest, sourceKey } from '../src/manufacturing/schema.ts';

const fixture = resolve('fixtures/manufacturing/anomaly');
const read = (name: string): unknown => JSON.parse(readFileSync(join(fixture, name + '.json'), 'utf8')) as unknown;
const home = mkdtempSync(join(tmpdir(), 'swarm-manufacturing-demo-'));
const clock = new ManualClock();
const rt = openRuntime({ home, clock });
try {
  const m = new ManufacturingInvestigations(rt.store, read('policy'));
  const principal = parsePrincipal(read('principal')), batch = parseBatch(read('sources')), request = parseRequest(read('request'));
  m.repository.ingest(batch, principal);
  const before = m.investigate(request, principal);
  const evaluation = compareHardware(before.packet, {
    required_ids: ['SYN-MAT-L17', 'SYN-SN008', 'SYN-SN009', 'SYN-SN010', 'SYN-ASM-020', 'SYN-ASM-021', 'SYN-ASM-022'],
    expected_unknown_keys: ['SYN-SN010', `unresolved:${sourceKey({ system: 'syn-mes', type: 'hardware', native_id: 'SYN-SN011' })}`],
  });
  assert(evaluation.matches_reference, 'demo', 'Synthetic candidate set differs from fixture reference');
  m.review(before.packet.id, before.packet.hash, 'acknowledged', 'SCRIPTED FIXTURE REVIEW. No real human review or engineering approval.', principal);
  const correction = structuredClone(batch.records.find(r => r.source.native_id === 'SYN-CONTRARY-009')!);
  assert(correction.kind === 'configuration' && correction.payload, 'demo', 'Expected configuration');
  correction.revision = 2; correction.payload.value = 'SYN-PS-12 Rev C';
  clock.advance(60_000); m.repository.ingest({ ...batch, records: [correction] }, principal);
  const historical = m.packet(before.packet.id, principal), revised = m.investigate(request, principal);
  assert(historical.currency === 'stale' && !historical.reviews[0]!.current, 'demo', 'Correction must invalidate the scripted review');
  assert(revised.packet.configuration.find(c => c.hardware_id === 'SYN-SN009')!.dimensions[0]!.state === 'known', 'demo', 'Correction should reconcile the process assertion');
  const dir = resolve('evidence/manufacturing'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'packet.md'), packetMarkdown(before));
  writeFileSync(join(dir, 'packet.json'), JSON.stringify(before, null, 2) + '\n');
  const summary = {
    evidence_class: 'synthetic', model_calls: 0, external_system_writes: 0, real_human_reviews: 0,
    fixture_comparison: evaluation, candidates: before.packet.impact.candidates.length,
    original_packet_hash: before.packet.hash, corrected_packet_hash: revised.packet.hash,
    old_review_current_after_correction: historical.reviews[0]!.current,
    corrected_packet_requires_new_review: revised.reviews.length === 0,
    limitations: ['Invented hardware and source records', 'Public fixture reference, not held-out evidence', 'Scripted review demonstrates mechanics only', 'No live MES/PLM/QMS connection or engineering correctness claim'],
  };
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
} finally { rt.close(); rmSync(home, { recursive: true, force: true }); }
