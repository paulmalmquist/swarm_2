import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, hashOf } from '../../src/lib/util.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const batch = JSON.parse(readFileSync(resolve(root, 'fixtures/manufacturing/anomaly/sources.json'), 'utf8'));
const rows = [];
let sequence = 0;
const append = (record, hour = 0, dataset = batch.dataset_id) => rows.push({
  dataset_id: dataset, data_class: 'synthetic', ingestion_sequence: ++sequence,
  known_from_text: `2026-11-14T${String(hour).padStart(2, '0')}:00:00.000Z`,
  record_hash: hashOf(record), record_json: canonicalize(record),
});
const copy = id => structuredClone(batch.records.find(r => r.source.native_id === id));
for (const record of batch.records) append(record);
const originalMax = sequence;
const corrected = copy('SYN-CONTRARY-009'); corrected.revision = 3; corrected.payload.value = 'SYN-PS-12 Rev C'; append(corrected, 1);
const old = copy('SYN-CONTRARY-009'); old.revision = 2; append(old, 2);
const renamed = copy('SYN-SN008'); renamed.revision = 2; renamed.payload.label = 'SYN-SN008 corrected label'; append(renamed, 3);
const finding = copy('SYN-NCR-1042'); finding.revision = 2; finding.payload.description = 'Synthetic revised narrative; same physical finding.'; append(finding, 4);
const late = copy('SYN-SN010'); late.source.native_id = 'SYN-SN011'; late.payload.id = 'SYN-SN011'; late.payload.label = 'SYN-SN011'; append(late, 5);
for (const n of ['012','013']) {
  const hardware = copy('SYN-SN009'); hardware.source.native_id = `SYN-SN${n}`; hardware.payload.id = `SYN-SN${n}`; hardware.payload.label = `SYN-SN${n}`;
  hardware.payload.aliases = [{ system: 'syn-vendor', type: 'serial', native_id: 'SHARED' }, structuredClone(hardware.source)]; append(hardware, 6);
}
const ambiguous = copy('SYN-LOT-LINK-008'); ambiguous.source.native_id = 'SYN-AMBIGUOUS-LINK'; ambiguous.payload.from = { system: 'syn-vendor', type: 'serial', native_id: 'SHARED' }; append(ambiguous, 6);
const withdrawn = copy('SYN-QT-77'); withdrawn.revision = 2; withdrawn.withdrawn = true; withdrawn.payload = null; append(withdrawn, 7);
append(copy('SYN-SN009'), 8); // duplicate delivery, same source revision and bytes
append(copy('SYN-SN008'), 8, 'synthetic-other'); // same native ids in another dataset

const fields = Object.keys(rows[0]);
const csv = value => '"' + String(value).replaceAll('"', '""') + '"';
const dir = resolve(root, 'warehouse/seeds'); mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'raw_manufacturing_versions.csv'), fields.join(',') + '\n' + rows.map(r => fields.map(f => csv(r[f])).join(',')).join('\n') + '\n');
writeFileSync(resolve(root, 'warehouse/fixture-vars.yml'), `manufacturing_fixture_mode: true\nconsumer_dataset_id: synthetic-anomaly\nconsumer_valid_at: '2026-11-09T00:00:00.000Z'\n`);
writeFileSync(resolve(root, 'warehouse/fixture-manifest.json'), JSON.stringify({ evidence_class: 'synthetic', initial_sequence: originalMax, deliveries: rows.length, scenarios: ['replay', 'late correction', 'out-of-order revision', 'Type 2 hardware change', 'finding revision', 'late-arriving dimension', 'ambiguous alias', 'withdrawal', 'dataset separation'] }, null, 2) + '\n');
