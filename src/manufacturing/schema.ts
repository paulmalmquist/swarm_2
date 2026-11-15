import { assert, hashOf } from '../lib/util.ts';

export const DIMENSIONS = ['design_revision', 'geometry', 'material', 'material_lot', 'process', 'supplier', 'site', 'equipment', 'environment', 'test_procedure', 'test_setup', 'instrumentation', 'firmware'] as const;
export type Dimension = typeof DIMENSIONS[number];
export type ConfigurationScope = 'designed' | 'planned' | 'built' | 'installed' | 'tested';
export type SourceIdentity = { system: string; type: string; native_id: string };
export type Principal = { id: string; entitlements: string[] };
export type Hardware = {
  id: string; label: string; hardware_kind: 'part_definition' | 'serial' | 'lot' | 'assembly' | 'article';
  aliases: SourceIdentity[]; genealogy_status: 'declared_complete' | 'incomplete' | 'unverified';
};
export type Relationship = {
  from: SourceIdentity; to: SourceIdentity;
  relationship: 'produced_from' | 'installed_in' | 'split_from' | 'merged_from';
};
export type Configuration = { hardware: SourceIdentity; scope: ConfigurationScope; dimension: Dimension; value: string };
export type Finding = { hardware: SourceIdentity; observed_at: string; description: string };
export type ManufacturingEvidence = {
  hardware: SourceIdentity; evidence_class: 'qualification' | 'acceptance' | 'inspection' | 'process_validation' | 'analysis';
  configuration: Partial<Record<Dimension, string>>; description: string;
};
export type Payloads = { hardware: Hardware; relationship: Relationship; configuration: Configuration; finding: Finding; evidence: ManufacturingEvidence };
export type RecordKind = keyof Payloads;
export type SourceRecord = { [K in RecordKind]: {
  source: SourceIdentity; revision: number; valid_from: string; valid_to: string | null;
  access_tags: string[]; withdrawn: boolean; kind: K; payload: Payloads[K] | null;
} }[RecordKind];
export type TypedRecord<K extends RecordKind> = Extract<SourceRecord, { kind: K }> & { payload: Payloads[K] };
export type SourceBatch = { dataset_id: string; data_class: 'synthetic' | 'real'; records: SourceRecord[] };
export type SourceVersion = {
  sequence: number; dataset_id: string; data_class: SourceBatch['data_class']; source_key: string;
  record_hash: string; known_from: string; record: SourceRecord;
};
export type Snapshot = { id: string; hash: string; dataset_id: string; data_class: SourceBatch['data_class']; known_at: string; watermark: number; versions: SourceVersion[] };
export type ManufacturingPolicy = {
  id: string; revision: number;
  configuration_authorities: { scope: ConfigurationScope; dimension: Dimension; systems: string[] }[];
  reviewers: { principal_id: string; role: 'engineering' | 'quality' }[];
};
export type InvestigationRequest = {
  dataset_id: string; finding: SourceIdentity; seed_lot: SourceIdentity;
  exposure_start: string; exposure_end: string; configuration_at: string;
  configuration_scope: ConfigurationScope; required_dimensions: Dimension[];
  claim_class: ManufacturingEvidence['evidence_class']; known_at?: string;
};

export const sourceKey = (s: SourceIdentity): string => hashOf([s.system, s.type, s.native_id]);
export const sourceLabel = (s: SourceIdentity): string => `${s.system}/${s.type}/${s.native_id}`;
export const includesTime = (r: SourceRecord, at: string): boolean => r.valid_from <= at && (r.valid_to === null || at < r.valid_to);
export function recordsOf<K extends RecordKind>(s: Snapshot, kind: K): (SourceVersion & { record: TypedRecord<K> })[] {
  return s.versions.filter(v => v.record.kind === kind && !v.record.withdrawn) as (SourceVersion & { record: TypedRecord<K> })[];
}

// These validators run at the JSON boundary. TypeScript assertions alone do not validate imported data.
type Obj = Record<string, unknown>;
function object(v: unknown, keys: string[]): asserts v is Obj {
  assert(v !== null && typeof v === 'object' && !Array.isArray(v), 'manufacturing_schema', 'Expected an object');
  assert(Object.keys(v).every(k => keys.includes(k)), 'manufacturing_schema', 'Unexpected field');
}
function str(v: unknown): asserts v is string { assert(typeof v === 'string' && v.trim().length > 0 && v.length <= 4000, 'manufacturing_schema', 'Expected nonempty bounded text'); }
function enumeration(v: unknown, values: readonly string[]): void { assert(typeof v === 'string' && values.includes(v), 'manufacturing_schema', 'Invalid enum value'); }
function strings(v: unknown, max = 100): asserts v is string[] {
  assert(Array.isArray(v) && v.length > 0 && v.length <= max, 'manufacturing_schema', 'Expected nonempty bounded list');
  v.forEach(str); assert(new Set(v).size === v.length, 'manufacturing_schema', 'Duplicate list entry');
}
export function timestamp(v: unknown): asserts v is string {
  str(v); assert(Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v, 'manufacturing_schema', 'Use canonical UTC timestamps, e.g. 2026-11-01T00:00:00.000Z');
}
function revision(v: unknown): void { assert(Number.isSafeInteger(v) && (v as number) > 0, 'manufacturing_schema', 'Revision must be a positive integer'); }
function identity(v: unknown): asserts v is SourceIdentity {
  object(v, ['system', 'type', 'native_id']); str(v.system); str(v.type); str(v.native_id);
}
const SCOPES = ['designed', 'planned', 'built', 'installed', 'tested'];
const CLASSES = ['qualification', 'acceptance', 'inspection', 'process_validation', 'analysis'];
function record(v: unknown): void {
  object(v, ['source', 'revision', 'valid_from', 'valid_to', 'access_tags', 'withdrawn', 'kind', 'payload']);
  identity(v.source); revision(v.revision); timestamp(v.valid_from);
  if (v.valid_to !== null) { timestamp(v.valid_to); assert(v.valid_to > v.valid_from, 'manufacturing_schema', 'Empty or reversed valid-time interval'); }
  strings(v.access_tags); enumeration(v.kind, ['hardware', 'relationship', 'configuration', 'finding', 'evidence']);
  assert(typeof v.withdrawn === 'boolean', 'manufacturing_schema', 'withdrawn must be explicit');
  if (v.withdrawn) { assert(v.payload === null, 'manufacturing_schema', 'Withdrawal must have null payload'); return; }
  const p = v.payload;
  switch (v.kind) {
    case 'hardware':
      object(p, ['id', 'label', 'hardware_kind', 'aliases', 'genealogy_status']); str(p.id); str(p.label);
      enumeration(p.hardware_kind, ['part_definition', 'serial', 'lot', 'assembly', 'article']);
      enumeration(p.genealogy_status, ['declared_complete', 'incomplete', 'unverified']);
      assert(Array.isArray(p.aliases) && p.aliases.length <= 100, 'manufacturing_schema', 'Invalid aliases'); p.aliases.forEach(identity); break;
    case 'relationship':
      object(p, ['from', 'to', 'relationship']); identity(p.from); identity(p.to);
      enumeration(p.relationship, ['produced_from', 'installed_in', 'split_from', 'merged_from']);
      assert(sourceKey(p.from) !== sourceKey(p.to), 'manufacturing_schema', 'Self relationship'); break;
    case 'configuration':
      object(p, ['hardware', 'scope', 'dimension', 'value']); identity(p.hardware); enumeration(p.scope, SCOPES); enumeration(p.dimension, DIMENSIONS); str(p.value); break;
    case 'finding':
      object(p, ['hardware', 'observed_at', 'description']); identity(p.hardware); timestamp(p.observed_at); str(p.description); break;
    case 'evidence':
      object(p, ['hardware', 'evidence_class', 'configuration', 'description']); identity(p.hardware); enumeration(p.evidence_class, CLASSES); str(p.description);
      object(p.configuration, [...DIMENSIONS]); Object.values(p.configuration).forEach(str); break;
  }
}
export function parseBatch(value: unknown): SourceBatch {
  object(value, ['dataset_id', 'data_class', 'records']); str(value.dataset_id); enumeration(value.data_class, ['synthetic', 'real']);
  assert(Array.isArray(value.records) && value.records.length > 0 && value.records.length <= 2000, 'manufacturing_schema', 'Import 1–2000 records per batch');
  value.records.forEach(record);
  assert(Buffer.byteLength(JSON.stringify(value)) <= 8 * 1024 * 1024, 'manufacturing_schema', 'Batch too large');
  return structuredClone(value) as SourceBatch;
}
export function parsePrincipal(value: unknown): Principal {
  object(value, ['id', 'entitlements']); str(value.id); strings(value.entitlements); return structuredClone(value) as Principal;
}
export function parsePolicy(value: unknown): ManufacturingPolicy {
  object(value, ['id', 'revision', 'configuration_authorities', 'reviewers']); str(value.id); revision(value.revision);
  assert(Array.isArray(value.configuration_authorities) && value.configuration_authorities.length <= 100, 'manufacturing_schema', 'Invalid authority policy');
  const seen = new Set<string>();
  for (const rule of value.configuration_authorities) {
    object(rule, ['scope', 'dimension', 'systems']); enumeration(rule.scope, SCOPES); enumeration(rule.dimension, DIMENSIONS); strings(rule.systems);
    const key = `${rule.scope}/${rule.dimension}`; assert(!seen.has(key), 'manufacturing_schema', 'Duplicate authority rule'); seen.add(key);
  }
  assert(Array.isArray(value.reviewers) && value.reviewers.length <= 100, 'manufacturing_schema', 'Invalid reviewer policy');
  for (const r of value.reviewers) { object(r, ['principal_id', 'role']); str(r.principal_id); enumeration(r.role, ['engineering', 'quality']); }
  return structuredClone(value) as ManufacturingPolicy;
}
export function parseRequest(value: unknown): InvestigationRequest {
  object(value, ['dataset_id', 'finding', 'seed_lot', 'exposure_start', 'exposure_end', 'configuration_at', 'configuration_scope', 'required_dimensions', 'claim_class', 'known_at']);
  str(value.dataset_id); identity(value.finding); identity(value.seed_lot);
  timestamp(value.exposure_start); timestamp(value.exposure_end); timestamp(value.configuration_at);
  assert(value.exposure_start < value.exposure_end, 'manufacturing_schema', 'Exposure window must be nonempty');
  if (value.known_at !== undefined) timestamp(value.known_at);
  enumeration(value.configuration_scope, SCOPES); enumeration(value.claim_class, CLASSES);
  strings(value.required_dimensions, DIMENSIONS.length); value.required_dimensions.forEach(d => enumeration(d, DIMENSIONS));
  return structuredClone(value) as InvestigationRequest;
}
export function requireAccess(principal: Principal, tags: string[]): void {
  assert(tags.every(t => principal.entitlements.includes(t)), 'manufacturing_access', 'Source access denied');
}
