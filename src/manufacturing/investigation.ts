import { readFileSync } from 'node:fs';
import { assert, hashOf, sha256 } from '../lib/util.ts';
import type { Store } from '../store/store.ts';
import { assessEvidence, configurationFor } from './evidence.ts';
import type { ConfigurationView, EvidenceAssessment } from './evidence.ts';
import { traceImpact } from './impact.ts';
import { IdentityIndex } from './identity.ts';
import type { ImpactResult } from './impact.ts';
import { parsePolicy, parsePrincipal, parseRequest, recordsOf, sourceLabel } from './schema.ts';
import type { InvestigationRequest, ManufacturingPolicy, Principal, Snapshot } from './schema.ts';
import { ManufacturingStore } from './store.ts';

export const ENGINE_VERSION = 'affected-hardware-v1';
// Bind actual analysis/review code, not just a manually maintained version label.
export const ENGINE_HASH = hashOf(['schema.ts', 'identity.ts', 'impact.ts', 'evidence.ts', 'investigation.ts', 'store.ts', '../lib/util.ts'].map(file => ({ file, hash: sha256(readFileSync(new URL(file, import.meta.url))) })));
export type InvestigationPacket = {
  id: string; hash: string; data_class: 'synthetic' | 'real'; mode: 'read_only_decision_support'; authorizes_hardware_action: false;
  manifest: { engine_version: string; engine_hash: string; snapshot_id: string; snapshot_hash: string; policy_hash: string; request: InvestigationRequest };
  authority_policy: ManufacturingPolicy;
  impact: ImpactResult; configuration: ConfigurationView[]; evidence: EvidenceAssessment[];
  citations: { source: string; revision: number; hash: string; kind: string; known_from: string; valid_from: string; valid_to: string | null; withdrawn: boolean }[];
};
export type PacketReview = {
  id: string; packet_id: string; packet_hash: string; snapshot_hash: string; policy_hash: string;
  principal_id: string; role: 'engineering' | 'quality'; outcome: 'acknowledged' | 'needs_more_evidence';
  rationale: string; reviewed_at: string; authorizes_hardware_action: false;
  provenance: 'local_operator_assertion'; data_class: 'synthetic' | 'real';
};
export type PacketState = { packet: InvestigationPacket; currency: 'current' | 'stale'; stale_reasons: string[]; reviews: (PacketReview & { current: boolean })[] };

export class ManufacturingInvestigations {
  repository: ManufacturingStore;
  private policy: ManufacturingPolicy;
  constructor(store: Store, policy: unknown) { this.repository = new ManufacturingStore(store); this.policy = parsePolicy(policy); }

  investigate(value: unknown, actor: Principal): PacketState {
    const request = parseRequest(value), principal = parsePrincipal(actor);
    return this.repository.store.db.tx(() => {
      const snapshot = this.repository.snapshot(request.dataset_id, principal, request.known_at);
      const impact = traceImpact(snapshot, request);
      const identities = new IdentityIndex(snapshot);
      const configuration = impact.candidates.filter(c => c.hardware_id !== null).map(c => configurationFor(snapshot, c.hardware_id!, request, this.policy, identities));
      const sources = recordsOf(snapshot, 'evidence');
      assert(sources.length * configuration.length <= 20_000, 'manufacturing_scope', 'Narrow the scope before comparing this many evidence/hardware pairs');
      const evidence = configuration.flatMap(c => sources.map(e => assessEvidence(snapshot, c, e, request, identities)));
      const body = {
        data_class: snapshot.data_class, mode: 'read_only_decision_support' as const, authorizes_hardware_action: false as const,
        manifest: { engine_version: ENGINE_VERSION, engine_hash: ENGINE_HASH, snapshot_id: snapshot.id, snapshot_hash: snapshot.hash, policy_hash: hashOf(this.policy), request },
        authority_policy: this.policy,
        impact, configuration, evidence,
        citations: snapshot.versions.map(v => ({ source: sourceLabel(v.record.source), revision: v.record.revision, hash: v.record_hash, kind: v.record.kind, known_from: v.known_from, valid_from: v.record.valid_from, valid_to: v.record.valid_to, withdrawn: v.record.withdrawn })),
      };
      assert(Buffer.byteLength(JSON.stringify(body)) <= 16 * 1024 * 1024, 'manufacturing_scope', 'Packet exceeds pilot size; narrow the investigation');
      const hash = hashOf(body), packet: InvestigationPacket = { id: `mp_${hash}`, hash, ...body };
      const existing = this.repository.read('manufacturing_packets', packet.id);
      this.repository.insert('manufacturing_packets', packet.id, packet);
      if (!existing) this.repository.store.emit({ type: 'manufacturing_packet_created', actor_id: principal.id, actor_kind: 'operator', payload: { packet_id: packet.id, data_class: snapshot.data_class } });
      return this.packet(packet.id, principal);
    });
  }

  packet(id: string, actor: Principal): PacketState {
    return this.repository.store.db.tx(() => this.readPacket(id, actor));
  }

  private readPacket(id: string, actor: Principal): PacketState {
    const packet = this.repository.read<InvestigationPacket>('manufacturing_packets', id);
    assert(packet, 'manufacturing_missing', 'Packet not found');
    const snapshot = this.repository.readSnapshot(packet.manifest.snapshot_id, actor);
    const { id: unused, hash, ...body } = packet;
    assert(hashOf(body) === hash && unused === `mp_${hash}` && packet.manifest.snapshot_hash === snapshot.hash, 'manufacturing_integrity', 'Packet hash mismatch');
    const reasons: string[] = [];
    // New records matter too: a new sibling is a dependency even if it was absent from the old packet.
    if (snapshot.watermark !== this.repository.watermark(snapshot.dataset_id)) reasons.push('source_dataset_changed');
    if (packet.manifest.policy_hash !== hashOf(this.policy)) reasons.push('authority_policy_changed');
    if (packet.manifest.engine_version !== ENGINE_VERSION || packet.manifest.engine_hash !== ENGINE_HASH) reasons.push('analysis_rules_changed');
    return { packet, currency: reasons.length ? 'stale' : 'current', stale_reasons: reasons, reviews: this.repository.reviews<PacketReview>(id).map(r => ({ ...r, current: reasons.length === 0 && r.packet_hash === hash })) };
  }

  sourceBundle(id: string, actor: Principal): Snapshot {
    const state = this.packet(id, actor);
    return this.repository.readSnapshot(state.packet.manifest.snapshot_id, actor);
  }

  review(id: string, expectedHash: string, outcome: PacketReview['outcome'], rationale: string, actor: Principal): PacketState {
    const principal = parsePrincipal(actor);
    assert(['acknowledged', 'needs_more_evidence'].includes(outcome), 'manufacturing_review', 'Review cannot authorize a hardware disposition');
    assert(typeof rationale === 'string' && rationale.trim().length > 0 && rationale.length <= 4000, 'manufacturing_review', 'A bounded rationale is required');
    return this.repository.store.db.tx(() => {
      const state = this.packet(id, principal);
      assert(state.currency === 'current', 'manufacturing_stale', 'Source data or policy changed; create and review a new packet');
      assert(state.packet.hash === expectedHash, 'manufacturing_review', 'Review must name the exact packet hash');
      const grant = this.policy.reviewers.find(r => r.principal_id === principal.id);
      assert(grant, 'manufacturing_authority', 'No engineering/quality review grant for this principal');
      const body = { packet_id: id, packet_hash: expectedHash, snapshot_hash: state.packet.manifest.snapshot_hash, policy_hash: hashOf(this.policy), principal_id: principal.id, role: grant.role, outcome, rationale, authorizes_hardware_action: false as const, provenance: 'local_operator_assertion' as const, data_class: state.packet.data_class };
      const reviewId = `mr_${hashOf(body)}`;
      if (!this.repository.read('manufacturing_reviews', reviewId)) {
        this.repository.insert('manufacturing_reviews', reviewId, { id: reviewId, ...body, reviewed_at: this.repository.store.clock.iso() } satisfies PacketReview);
        this.repository.store.emit({ type: 'manufacturing_packet_reviewed', actor_id: principal.id, actor_kind: 'operator', payload: { packet_id: id, outcome, data_class: state.packet.data_class, provenance: body.provenance } });
      }
      return this.packet(id, principal);
    });
  }
}

const cell = (s: string): string => s.replace(/[|\n\r]/g, ' ').replace(/[\\`*_{}\[\]()!#]/g, '\\$&').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
export function packetMarkdown(state: PacketState): string {
  const p = state.packet;
  const lines = [
    '# Affected hardware investigation', '',
    `Evidence: **${p.data_class}** · Packet: **${state.currency}** · Decision support only.`,
    'This packet does not authorize a hold, release, disposition, rework, retest or physical-completion claim.', '',
    `Finding: ${cell(sourceLabel(p.manifest.request.finding))}`,
    `Lot hypothesis: ${cell(sourceLabel(p.manifest.request.seed_lot))}`,
    `Exposure: ${p.manifest.request.exposure_start} to ${p.manifest.request.exposure_end} (end excluded).`,
    `Packet hash: \`${p.hash}\``, `Snapshot hash: \`${p.manifest.snapshot_hash}\``, '',
    '| Hardware | Assessment | Basis |', '|---|---|---|',
    ...p.impact.candidates.map(c => `| ${cell(c.label)} | ${c.status}${c.is_finding_subject ? '; finding subject' : ''} | ${cell(c.reasons.join('; '))} |`), '',
    '## Gaps and conflicts', '',
    ...p.impact.issues.map(i => `- ${cell(i.code)}: ${cell(i.detail)}`),
    ...p.configuration.flatMap(c => c.dimensions.filter(d => d.state !== 'known').map(d => `- ${cell(c.hardware_id)} / ${d.dimension}: **${d.state}**.`)),
    `- Unassessed hardware: ${p.impact.unassessed_hardware.map(cell).join(', ') || 'none in this export'}. No path does not mean unaffected.`, '',
    '## Relationship paths', '',
    ...p.impact.candidates.flatMap(c => c.paths.map(path => `- ${cell(c.label)}: ${path.map(s => `${cell(s.from)} → ${cell(s.to)} (${s.relationship}; ${cell(sourceLabel(s.source))}; \`${s.source_hash}\`)`).join('; ')}`)), '',
    '## Evidence applicability', '',
    'Coverage describes only the requested configuration dimensions. Even a full match requires engineering review.', '',
    '| Target | Evidence hash | Class | Result | Coverage |', '|---|---|---|---|---|',
    ...p.evidence.map(e => `| ${cell(e.target_hardware_id)} | \`${e.evidence_source_hash}\` | ${e.evidence_class} | ${e.status} | ${e.coverage} |`), '',
    '## Review', '',
    ...state.reviews.map(r => `- ${cell(r.principal_id)} (${r.role}): ${r.outcome}; ${r.current ? 'current' : 'historical'} — ${cell(r.rationale)}`),
    ...(state.reviews.length ? [] : ['No engineering/quality packet review recorded.']),
    ...state.stale_reasons.map(r => `- Re-review required: ${r}.`), '',
    '## Source manifest', '',
    ...p.citations.map(c => `- ${cell(c.source)} @ ${c.revision}: \`${c.hash}\`${c.withdrawn ? ' (withdrawn)' : ''}. Known ${c.known_from}; valid ${c.valid_from} to ${c.valid_to ?? 'open'}.`), '',
  ];
  return lines.join('\n');
}
