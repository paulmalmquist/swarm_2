// SYNTHETIC WORKLOAD — "review a proposed change to a shared data contract".
//
// This file is the DEVELOPMENT side of the workload: the base contracts, the case shape and the
// mutation classes a candidate author is allowed to see and tune against. The held-out classes
// and seeds live in `protected/cases/review-holdout.ts`, which candidate code cannot read.
import { rng, seedFrom } from '../../src/lib/util.ts';

export interface Schema {
  type?: string | string[];
  description?: string;
  enum?: string[];
  required?: string[];
  properties?: Record<string, Schema>;
  'x-unit'?: string;
}

export interface ReviewCase {
  id: string;
  title: string;
  description: string;
  contract_name: string;
  contract_before: Schema;
  contract_after: Schema;
  files_changed: { path: string; kind: 'source' | 'test' | 'doc' | 'contract' }[];
}

export interface ReviewLabel {
  should_block: boolean;
  defect_class: string;
  /** Dot path of the affected field, when the defect has one. */
  field: string | null;
  /** Cost of letting this defect through, on a 0–8 scale. Zero for changes that are safe. */
  severity: number;
}

export interface LabeledCase {
  case: ReviewCase;
  label: ReviewLabel;
}

export interface ReviewFinding {
  step: string;
  class: string;
  field: string | null;
  severity: 'blocking' | 'advisory';
  message: string;
}

export interface ReviewOutput {
  verdict: 'approve' | 'request_changes';
  findings: ReviewFinding[];
  steps_run: number;
}

const str = (description?: string): Schema => ({ type: 'string', ...(description ? { description } : {}) });
const num = (unit?: string, nullable = false): Schema => ({ type: nullable ? ['number', 'null'] : 'number', ...(unit ? { 'x-unit': unit } : {}) });

/** Five invented record contracts with nested objects, enums, units and nullable fields. */
export const BASE_CONTRACTS: { name: string; schema: Schema }[] = [
  {
    name: 'syn.health_record',
    schema: {
      type: 'object',
      required: ['dataset_id', 'owner_team', 'freshness', 'schema_status'],
      properties: {
        dataset_id: str(),
        owner_team: str(),
        schema_status: { enum: ['match', 'drift', 'unknown'] },
        freshness: { type: 'object', required: ['status', 'staleness'], properties: { status: { enum: ['fresh', 'stale', 'unknown'] }, staleness: num('minutes', true), threshold: num('minutes') } },
      },
    },
  },
  {
    name: 'syn.part_measurement',
    schema: {
      type: 'object',
      required: ['part_no', 'feature', 'value', 'tolerance'],
      properties: {
        part_no: str(),
        feature: str(),
        value: num('millimetres'),
        disposition: { enum: ['accept', 'rework', 'scrap'] },
        tolerance: { type: 'object', required: ['lower', 'upper'], properties: { lower: num('millimetres'), upper: num('millimetres'), basis: str() } },
      },
    },
  },
  {
    name: 'syn.test_run',
    schema: {
      type: 'object',
      required: ['run_id', 'article', 'duration', 'outcome'],
      properties: {
        run_id: str(),
        article: str(),
        duration: num('seconds'),
        peak_load: num('kilonewtons', true),
        outcome: { enum: ['nominal', 'anomaly', 'aborted'] },
        conditions: { type: 'object', required: ['ambient'], properties: { ambient: num('kelvin'), operator: str() } },
      },
    },
  },
  {
    name: 'syn.supplier_delivery',
    schema: {
      type: 'object',
      required: ['po_number', 'supplier_id', 'quantity', 'received'],
      properties: {
        po_number: str(),
        supplier_id: str(),
        quantity: num('each'),
        lead_time: num('days', true),
        received: { type: 'object', required: ['status'], properties: { status: { enum: ['pending', 'partial', 'complete'] }, dock: str() } },
      },
    },
  },
  {
    name: 'syn.ncr_event',
    schema: {
      type: 'object',
      required: ['ncr_id', 'part_no', 'severity', 'disposition'],
      properties: {
        ncr_id: str(),
        part_no: str(),
        severity: { enum: ['minor', 'major', 'critical'] },
        hold_time: num('hours', true),
        disposition: { type: 'object', required: ['code'], properties: { code: { enum: ['use_as_is', 'rework', 'scrap'] }, approver: str() } },
      },
    },
  },
];

type Rand = () => number;
const pick = <T>(xs: T[], r: Rand): T => xs[Math.floor(r() * xs.length)]!;
const clone = (s: Schema): Schema => structuredClone(s);
const SRC = (name: string) => ({ path: `src/${name.replace('syn.', '')}.ts`, kind: 'source' as const });
const TEST = (name: string) => ({ path: `test/${name.replace('syn.', '')}.test.ts`, kind: 'test' as const });
const CONTRACT = (name: string) => ({ path: `contracts/${name}.schema.json`, kind: 'contract' as const });

function topFields(s: Schema, pred: (f: Schema, k: string) => boolean = () => true): string[] {
  return Object.entries(s.properties ?? {}).filter(([k, f]) => pred(f, k)).map(([k]) => k);
}
function nestedParent(s: Schema): string {
  return topFields(s, (f) => f.type === 'object')[0]!;
}

export interface Mutation {
  class: string;
  should_block: boolean;
  severity: number;
  apply(base: { name: string; schema: Schema }, r: Rand): { after: Schema; field: string | null; description: string; withTests: boolean };
}

/** Mutation classes visible to candidate authors. */
export const DEV_MUTATIONS: Mutation[] = [
  {
    class: 'field_removed', should_block: true, severity: 5,
    apply: (b, r) => { const after = clone(b.schema); const f = pick(topFields(after, (x) => x.type !== 'object'), r); delete after.properties![f]; after.required = (after.required ?? []).filter((x) => x !== f); return { after, field: f, description: `Clean up unused attributes on ${b.name}.`, withTests: true }; },
  },
  {
    class: 'field_renamed', should_block: true, severity: 5,
    apply: (b, r) => { const after = clone(b.schema); const f = pick(topFields(after, (x) => x.type !== 'object'), r); const props: Record<string, Schema> = {}; for (const [k, v] of Object.entries(after.properties!)) props[k === f ? `${f}_v2` : k] = v; after.properties = props; after.required = (after.required ?? []).map((x) => (x === f ? `${f}_v2` : x)); return { after, field: f, description: `Naming consistency pass on ${b.name}.`, withTests: true }; },
  },
  {
    class: 'type_changed', should_block: true, severity: 5,
    apply: (b, r) => { const after = clone(b.schema); const f = pick(topFields(after, (x) => x.type === 'string'), r); after.properties![f] = { ...after.properties![f], type: 'number' }; return { after, field: f, description: `Store ${f} more compactly.`, withTests: true }; },
  },
  {
    class: 'required_added', should_block: true, severity: 3,
    apply: (b) => { const after = clone(b.schema); after.properties!.source_system = str(); after.required = [...(after.required ?? []), 'source_system']; return { after, field: 'source_system', description: `Track the originating system on ${b.name}.`, withTests: true }; },
  },
  {
    class: 'enum_value_removed', should_block: true, severity: 3,
    apply: (b, r) => { const after = clone(b.schema); const f = pick(topFields(after, (x) => Array.isArray(x.enum)), r); after.properties![f] = { ...after.properties![f], enum: after.properties![f]!.enum!.slice(0, -1) }; return { after, field: f, description: `Retire a rarely used ${f} value.`, withTests: true }; },
  },
  {
    class: 'missing_tests', should_block: true, severity: 2,
    apply: (b) => ({ after: clone(b.schema), field: null, description: `Refactor the ${b.name} producer.`, withTests: false }),
  },
  {
    class: 'optional_field_added', should_block: false, severity: 0,
    apply: (b) => { const after = clone(b.schema); after.properties!.notes = str('free text'); return { after, field: null, description: `Add optional notes to ${b.name}.`, withTests: true }; },
  },
  {
    class: 'description_changed', should_block: false, severity: 0,
    apply: (b, r) => { const after = clone(b.schema); const f = pick(topFields(after, (x) => x.type === 'string'), r); after.properties![f] = { ...after.properties![f], description: 'clarified wording' }; return { after, field: null, description: `Clarify documentation on ${b.name}.`, withTests: true }; },
  },
  {
    class: 'no_contract_change', should_block: false, severity: 0,
    apply: (b) => ({ after: clone(b.schema), field: null, description: `Speed up the ${b.name} consumer.`, withTests: true }),
  },
];

export const DEV_WEIGHTS: Record<string, number> = { field_removed: 2, field_renamed: 2, type_changed: 2, required_added: 1, enum_value_removed: 1, missing_tests: 2, optional_field_added: 2, description_changed: 2, no_contract_change: 2 };

export function buildCase(id: string, m: Mutation, r: Rand): LabeledCase {
  // Not every mutation applies to every contract (one may have no top-level enum, say):
  // start at a random contract and take the first the mutation applies to.
  const start = Math.floor(r() * BASE_CONTRACTS.length);
  let base = BASE_CONTRACTS[start]!;
  let applied: ReturnType<Mutation['apply']> | null = null;
  for (let i = 0; i < BASE_CONTRACTS.length && !applied; i++) {
    base = BASE_CONTRACTS[(start + i) % BASE_CONTRACTS.length]!;
    try {
      const res = m.apply(base, r);
      if (res.field !== undefined) applied = res;
    } catch {
      applied = null;
    }
  }
  if (!applied) throw new Error(`mutation ${m.class} applies to no base contract`);
  const { after, field, description, withTests } = applied;
  const changed = JSON.stringify(after) !== JSON.stringify(base.schema);
  const files = [SRC(base.name), ...(changed ? [CONTRACT(base.name)] : []), ...(withTests ? [TEST(base.name)] : [])];
  return {
    case: { id, title: description, description, contract_name: base.name, contract_before: clone(base.schema), contract_after: after, files_changed: files },
    label: { should_block: m.should_block, defect_class: m.class, field, severity: m.severity },
  };
}

/** Deterministic case generation: the same seed always yields the same cases. */
export function generate(seed: string, n: number, mutations: Mutation[], weights: Record<string, number>): LabeledCase[] {
  const pool = mutations.flatMap((m) => Array<Mutation>(Math.max(0, Math.round((weights[m.class] ?? 0) * 2))).fill(m));
  const out: LabeledCase[] = [];
  for (let i = 0; i < n; i++) {
    const r = rng(seedFrom(`${seed}:${i}`));
    out.push(buildCase(`${seed}-${String(i).padStart(3, '0')}`, pick(pool, r), r));
  }
  return out;
}

/** Development cases: available to the optimizer, never used for a promotion decision. */
export function devCases(seed = 'dev-1', n = 40): LabeledCase[] {
  return generate(seed, n, DEV_MUTATIONS, DEV_WEIGHTS);
}

export { nestedParent, topFields, clone, str, num };
