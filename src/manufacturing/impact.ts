import { assert } from '../lib/util.ts';
import { IdentityIndex } from './identity.ts';
import { recordsOf, sourceKey, sourceLabel } from './schema.ts';
import type { InvestigationRequest, Snapshot, SourceIdentity, SourceVersion } from './schema.ts';

export type InvestigationIssue = { code: string; detail: string; source_hashes: string[] };
export type PathStep = { relationship: string; from: string; to: string; source: SourceIdentity; source_hash: string; valid_from: string; valid_to: string | null };
export type CandidateHardware = {
  key: string; hardware_id: string | null; label: string; status: 'potentially_affected' | 'unknown';
  is_finding_subject: boolean; reasons: string[]; paths: PathStep[][]; source_hashes: string[];
};
export type ImpactResult = {
  candidates: CandidateHardware[]; issues: InvestigationIssue[]; unassessed_hardware: string[];
  coverage: 'not_established'; not_found_means_unaffected: false; finding_source_hash: string;
};
const overlap = (a: string, b: string, v: SourceVersion): [string, string] | null => {
  const lo = a > v.record.valid_from ? a : v.record.valid_from;
  const hi = v.record.valid_to && v.record.valid_to < b ? v.record.valid_to : b;
  return lo < hi ? [lo, hi] : null;
};

/** A bounded hypothesis: descendants of a selected lot, then their installed parent assemblies.
 * Never fan back down from a parent assembly into unrelated components. Never infer causality.
 */
export function traceImpact(snapshot: Snapshot, request: InvestigationRequest): ImpactResult {
  const index = new IdentityIndex(snapshot);
  const finding = recordsOf(snapshot, 'finding').find(v => sourceKey(v.record.source) === sourceKey(request.finding));
  assert(finding, 'manufacturing_finding', 'Finding missing or withdrawn in this snapshot');
  const out: ImpactResult = { candidates: [], issues: [], unassessed_hardware: [], coverage: 'not_established', not_found_means_unaffected: false, finding_source_hash: finding.record_hash };
  const candidates = new Map<string, CandidateHardware>();
  const issue = (code: string, detail: string, hashes: string[] = []): void => {
    if (!out.issues.some(i => i.code === code && i.detail === detail)) out.issues.push({ code, detail, source_hashes: hashes });
  };
  const add = (ref: SourceIdentity, path: PathStep[], reason: string, subject = false, uncertain = false): CandidateHardware => {
    const resolution = index.resolve(ref);
    const key = resolution.status === 'resolved' ? resolution.hardware.id : `unresolved:${sourceKey(ref)}`;
    let item = candidates.get(key);
    if (!item) {
      item = { key, hardware_id: resolution.status === 'resolved' ? key : null, label: resolution.status === 'resolved' ? resolution.hardware.label : sourceLabel(ref), status: 'potentially_affected', is_finding_subject: subject, reasons: [], paths: [], source_hashes: [] };
      candidates.set(key, item);
    }
    item.is_finding_subject ||= subject;
    if (!item.reasons.includes(reason)) item.reasons.push(reason);
    if (resolution.status !== 'resolved') {
      item.status = 'unknown';
      issue(`identity_${resolution.status}`, `Cannot uniquely resolve ${sourceLabel(ref)}`, path.map(p => p.source_hash));
    } else {
      if (!item.source_hashes.includes(resolution.source.record_hash)) item.source_hashes.push(resolution.source.record_hash);
      if (resolution.hardware.genealogy_status !== 'declared_complete') {
        issue('genealogy_not_complete', `${key}: source genealogy is ${resolution.hardware.genealogy_status}`, [resolution.source.record_hash]);
        if (resolution.hardware.genealogy_status === 'incomplete') item.status = 'unknown';
      }
    }
    if (uncertain) item.status = 'unknown';
    if (path.length) {
      if (item.paths.length < 8) item.paths.push(path);
      else issue('path_display_limit', `${key}: additional paths omitted from presentation`);
      for (const step of path) if (!item.source_hashes.includes(step.source_hash)) item.source_hashes.push(step.source_hash);
    }
    return item;
  };
  add(finding.record.payload.hardware, [], 'Recorded subject of the finding; no disposition inferred', true);
  const seed = index.resolve(request.seed_lot);
  add(request.seed_lot, [], 'Investigator-selected lot hypothesis; causal relevance is unproven');
  if (seed.status === 'resolved') assert(seed.hardware.hardware_kind === 'lot', 'manufacturing_seed', 'This pilot requires a lot seed');

  const edges = recordsOf(snapshot, 'relationship').map(v => ({ v, from: index.resolve(v.record.payload.from), to: index.resolve(v.record.payload.to) }));
  type State = { id: string; start: string; end: string; path: PathStep[]; visited: string[] };
  const queue: State[] = [];
  if (seed.status === 'resolved') {
    const range = overlap(request.exposure_start, request.exposure_end, seed.source);
    if (range) queue.push({ id: seed.hardware.id, start: range[0], end: range[1], path: [], visited: [seed.hardware.id] });
    else { candidates.get(seed.hardware.id)!.status = 'unknown'; issue('seed_outside_window', 'Lot identity has no validity in the requested exposure window', [seed.source.record_hash]); }
  }
  const reached = new Map<string, [string, string][]>();
  let steps = 0;
  while (queue.length) {
    const state = queue.shift()!;
    if (++steps > 2000 || candidates.size > 500) { issue('traversal_limit', 'Investigation scope exceeded the pilot bound; closure is unknown'); break; }
    if (state.path.length >= 32) { issue('depth_limit', `Traversal stopped at ${state.id}; closure is unknown`); continue; }
    const ranges = reached.get(state.id) ?? [];
    if (ranges.some(([a, b]) => a <= state.start && b >= state.end)) continue;
    reached.set(state.id, [...ranges, [state.start, state.end]]);
    for (const { v, from, to } of edges) {
      const p = v.record.payload;
      const forward = p.relationship === 'installed_in';
      const current = forward ? from : to, next = forward ? to : from;
      const currentMatches = current.status === 'resolved' ? current.hardware.id === state.id : current.candidate_ids.includes(state.id);
      if (!currentMatches) continue;
      const range = overlap(state.start, state.end, v); if (!range) continue;
      const nextRef = forward ? p.to : p.from;
      const nextLabel = next.status === 'resolved' ? next.hardware.id : sourceLabel(nextRef);
      const path = [...state.path, { relationship: p.relationship, from: state.id, to: nextLabel, source: v.record.source, source_hash: v.record_hash, valid_from: v.record.valid_from, valid_to: v.record.valid_to }];
      if (current.status !== 'resolved' || next.status !== 'resolved') {
        add(nextRef, path, 'Unresolved identity on the candidate path', false, true);
        issue('ambiguous_path', `Cannot traverse ${sourceLabel(v.record.source)} without identity reconciliation`, [v.record_hash]); continue;
      }
      const validKinds = forward
        ? ['serial', 'assembly'].includes(from.status === 'resolved' ? from.hardware.hardware_kind : '') && ['assembly', 'article'].includes(next.hardware.hardware_kind)
        : current.hardware.hardware_kind === 'lot' && (p.relationship === 'produced_from' ? ['serial', 'lot', 'assembly'].includes(next.hardware.hardware_kind) : next.hardware.hardware_kind === 'lot');
      if (!validKinds) { add(nextRef, path, 'Relationship has incompatible hardware kinds', false, true); issue('invalid_relationship', sourceLabel(v.record.source), [v.record_hash]); continue; }
      const life = overlap(range[0], range[1], next.source);
      if (!life) { add(nextRef, path, 'Hardware identity and relationship validity disagree', false, true); issue('identity_time_conflict', next.hardware.id, [v.record_hash, next.source.record_hash]); continue; }
      add(nextRef, path, 'Source-backed candidate relationship; applicability requires review');
      if (state.visited.includes(next.hardware.id)) { issue('genealogy_cycle', `Cycle at ${next.hardware.id}`, path.map(x => x.source_hash)); continue; }
      queue.push({ id: next.hardware.id, start: life[0], end: life[1], path, visited: [...state.visited, next.hardware.id] });
    }
  }
  out.candidates = [...candidates.values()].sort((a, b) => a.key.localeCompare(b.key));
  const subject = index.resolve(finding.record.payload.hardware);
  if (subject.status === 'resolved' && subject.hardware.id !== (seed.status === 'resolved' ? seed.hardware.id : null) && !candidates.get(subject.hardware.id)?.paths.length) {
    issue('seed_not_linked_to_finding', 'No resolved path links the selected lot hypothesis to the finding subject; the hypothesis needs investigation.', [finding.record_hash]);
  }
  out.unassessed_hardware = [...new Set(recordsOf(snapshot, 'hardware').map(v => v.record.payload.id))].filter(id => !candidates.has(id)).sort();
  issue('coverage_not_established', 'No source export proves the complete hardware universe. Unreached hardware is unassessed, never unaffected.');
  return out;
}
