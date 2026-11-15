import { hashOf } from '../lib/util.ts';
import { IdentityIndex } from './identity.ts';
import { includesTime, recordsOf } from './schema.ts';
import type { Dimension, InvestigationRequest, ManufacturingPolicy, Snapshot, SourceVersion } from './schema.ts';

export type ConfigurationValue = { dimension: Dimension; state: 'known' | 'missing' | 'disputed' | 'unauthorized_source'; value: string | null; source_hashes: string[] };
export type ConfigurationView = { hardware_id: string; hash: string; dimensions: ConfigurationValue[] };
export function configurationFor(snapshot: Snapshot, hardware: string, request: InvestigationRequest, policy: ManufacturingPolicy, index = new IdentityIndex(snapshot)): ConfigurationView {
  const dimensions = request.required_dimensions.map(dimension => {
    const records = recordsOf(snapshot, 'configuration').filter(v => {
      const p = v.record.payload, identity = index.resolve(p.hardware);
      return p.scope === request.configuration_scope && p.dimension === dimension && includesTime(v.record, request.configuration_at) && (identity.status === 'resolved' ? identity.hardware.id === hardware : identity.candidate_ids.includes(hardware));
    });
    const authorities = policy.configuration_authorities.find(r => r.scope === request.configuration_scope && r.dimension === dimension)?.systems ?? [];
    const values = new Set(records.map(v => v.record.payload.value));
    const ambiguous = records.some(v => index.resolve(v.record.payload.hardware).status !== 'resolved');
    // Keep contrary assertions even when they came from a non-authoritative source.
    const state: ConfigurationValue['state'] = !records.length ? 'missing' : values.size > 1 || ambiguous ? 'disputed' : !records.some(v => authorities.includes(v.record.source.system)) ? 'unauthorized_source' : 'known';
    return { dimension, state, value: state === 'known' ? [...values][0]! : null, source_hashes: records.map(v => v.record_hash).sort() };
  });
  return { hardware_id: hardware, dimensions, hash: hashOf({ hardware, dimensions, at: request.configuration_at, scope: request.configuration_scope, policy_hash: hashOf(policy) }) };
}

export type EvidenceAssessment = {
  evidence_source_hash: string; target_hardware_id: string; target_configuration_hash: string;
  evidence_class: string; requested_claim_class: string; subject_match: boolean;
  status: 'candidate_for_review' | 'requires_engineering_judgment' | 'unknown' | 'class_mismatch';
  coverage: 'full' | 'partial' | 'none' | 'unknown';
  dimensions: { dimension: Dimension; result: 'exact' | 'changed' | 'missing' | 'disputed'; target: string | null; evidence: string | null; source_hashes: string[] }[];
  supports_acceptance: false;
};
export function assessEvidence(snapshot: Snapshot, target: ConfigurationView, evidence: SourceVersion, request: InvestigationRequest, index = new IdentityIndex(snapshot)): EvidenceAssessment {
  if (evidence.record.kind !== 'evidence' || !evidence.record.payload || evidence.record.withdrawn) throw new Error('Expected current evidence');
  const p = evidence.record.payload, identity = index.resolve(p.hardware);
  const subject_match = identity.status === 'resolved' && identity.hardware.id === target.hardware_id;
  const dimensions = target.dimensions.map(d => {
    const observed = p.configuration[d.dimension] ?? null;
    const result = d.state === 'disputed' ? 'disputed' : d.state !== 'known' || observed === null ? 'missing' : observed === d.value ? 'exact' : 'changed';
    return { dimension: d.dimension, result, target: d.value, evidence: observed, source_hashes: [...d.source_hashes, evidence.record_hash] } as EvidenceAssessment['dimensions'][number];
  });
  const classMismatch = p.evidence_class !== request.claim_class;
  const current = includesTime(evidence.record, request.configuration_at);
  const uncertain = !current || identity.status !== 'resolved' || dimensions.some(d => ['missing', 'disputed'].includes(d.result));
  const changed = !subject_match || dimensions.some(d => d.result === 'changed');
  const exact = dimensions.filter(d => d.result === 'exact').length;
  return {
    evidence_source_hash: evidence.record_hash, target_hardware_id: target.hardware_id, target_configuration_hash: target.hash,
    evidence_class: p.evidence_class, requested_claim_class: request.claim_class, subject_match,
    status: classMismatch ? 'class_mismatch' : uncertain ? 'unknown' : changed ? 'requires_engineering_judgment' : 'candidate_for_review',
    coverage: classMismatch || !current ? 'none' : uncertain ? exact ? 'partial' : 'unknown' : changed ? exact ? 'partial' : 'none' : 'full',
    dimensions, supports_acceptance: false,
  };
}
