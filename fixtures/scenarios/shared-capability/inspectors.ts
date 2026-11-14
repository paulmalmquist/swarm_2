// SYNTHETIC SCENARIO — structural inspections the runtime performs on document artifacts.
// They check that a document has the parts its criterion requires; they do not judge its quality.
import type { Inspector } from '../../../src/runtime.ts';

function parse(text: string | undefined): Record<string, unknown> | null {
  try {
    return JSON.parse(text ?? '') as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const inspectors: Record<string, Inspector> = {
  overlap_report: ({ artifacts }) => {
    const doc = parse(artifacts['discovery/overlap-report']);
    if (!doc) return { ok: false, details: 'the overlap report is not valid JSON' };
    const needs = (doc.distinct_needs ?? []) as { request_id?: string; stakeholder?: string; need?: string }[];
    const ids = (doc.consolidated_request_ids ?? []) as string[];
    if (typeof doc.shared_capability !== 'string' || !doc.shared_capability.trim()) return { ok: false, details: 'no shared capability is named' };
    if (ids.length < 2) return { ok: false, details: 'fewer than two requests are consolidated' };
    const missing = ids.filter((id) => !needs.some((n) => n.request_id === id && n.stakeholder && n.need));
    return { ok: missing.length === 0, details: missing.length ? `no distinct need recorded for ${missing.join(', ')}` : `${needs.length} distinct needs recorded for ${ids.length} consolidated requests` };
  },
  epistemics: ({ artifacts }) => {
    const doc = parse(artifacts['discovery/overlap-report']);
    const count = (k: string) => (Array.isArray(doc?.[k]) ? (doc![k] as unknown[]).length : 0);
    const ok = count('observed_facts') > 0 && count('interpretations') > 0 && count('unknowns') > 0;
    return { ok, details: `observed facts: ${count('observed_facts')}, interpretations: ${count('interpretations')}, unknowns: ${count('unknowns')}` };
  },
  criteria: ({ artifacts, mission, rt }) => {
    const doc = parse(artifacts['plan/acceptance-criteria']);
    if (!doc) return { ok: false, details: 'the criteria document is not valid JSON' };
    const criteria = (doc.criteria ?? []) as { criterion_id?: string; description?: string; verification_kind?: string }[];
    const vague = criteria.filter((c) => !c.criterion_id || (c.description ?? '').length < 15 || !c.verification_kind);
    if (criteria.length === 0 || vague.length) return { ok: false, details: `${vague.length} criteria lack an id, a description or a verification kind` };
    const mapped = new Set(((doc.needs_map ?? []) as { request_id: string }[]).map((m) => m.request_id));
    const deferred = new Set(((doc.deferred_needs ?? []) as { stakeholder: string; reason?: string }[]).filter((d) => d.reason).map((d) => d.stakeholder));
    // The consolidated needs are read from the store, not from the document under inspection.
    const needs = rt.store.needs.where('"mission_id" = ?', mission.id);
    const dropped = needs.filter((n) => !mapped.has(n.request_id) && !deferred.has(n.stakeholder));
    return { ok: dropped.length === 0, details: dropped.length ? `stakeholder need dropped without a criterion or a stated deferral: ${dropped.map((d) => d.stakeholder).join(', ')}` : `${needs.length} stakeholder needs each map to a criterion` };
  },
  contract: ({ artifacts }) => {
    const doc = parse(artifacts['contract/health-record']) as { version?: number; required?: string[]; properties?: Record<string, { properties?: Record<string, { enum?: string[] }> }> } | null;
    if (!doc) return { ok: false, details: 'the contract is not valid JSON' };
    const required = doc.required ?? [];
    const problems: string[] = [];
    if (typeof doc.version !== 'number') problems.push('no version number');
    for (const f of ['dataset_id', 'owner_team', 'freshness', 'schema']) if (!required.includes(f)) problems.push(`${f} is not required`);
    if (!doc.properties?.freshness?.properties?.status?.enum?.includes('unknown')) problems.push('freshness status cannot express unknown');
    return { ok: problems.length === 0, details: problems.length ? problems.join('; ') : `contract version ${doc.version} with ${required.length} required fields` };
  },
  knowledge: ({ artifacts }) => {
    const doc = parse(artifacts['knowledge/mission-notes']);
    const notes = (doc?.notes ?? []) as { kind?: string; statement?: string; scope?: string[]; source_refs?: string[] }[];
    const bad = notes.filter((n) => !n.kind || !n.statement || !n.scope?.length || !n.source_refs?.length);
    return { ok: notes.length > 0 && bad.length === 0, details: bad.length ? `${bad.length} notes lack a kind, scope or source` : `${notes.length} notes each carry kind, scope and source` };
  },
};
