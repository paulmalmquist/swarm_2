import type { InvestigationPacket } from './investigation.ts';

/** Diagnostic comparison against an independently supplied reference. This does not create ground truth. */
export function compareHardware(packet: InvestigationPacket, reference: { required_ids: string[]; expected_unknown_keys: string[] }): {
  missed_hardware: string[]; extra_candidates: string[]; missed_unknowns: string[]; matches_reference: boolean;
} {
  const found = new Set(packet.impact.candidates.flatMap(c => c.hardware_id ? [c.hardware_id] : []));
  const expected = new Set(reference.required_ids);
  const unknown = new Set(packet.impact.candidates.filter(c => c.status === 'unknown').map(c => c.key));
  const missed_hardware = [...expected].filter(id => !found.has(id)).sort();
  const extra_candidates = [...found].filter(id => !expected.has(id)).sort();
  const missed_unknowns = reference.expected_unknown_keys.filter(id => !unknown.has(id)).sort();
  return { missed_hardware, extra_candidates, missed_unknowns, matches_reference: !missed_hardware.length && !extra_candidates.length && !missed_unknowns.length };
}
