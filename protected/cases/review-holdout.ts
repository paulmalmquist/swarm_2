// PROTECTED — held-out side of the review workload.
//
// Adds mutation classes that development cases do not contain (subtle known failures and
// look-alike safe changes) and the registered held-out seeds. Candidate code never sees this
// file, its cases' labels, or its seeds. Only the release gate reads it.
import { type LabeledCase, type Mutation, type Schema, DEV_MUTATIONS, DEV_WEIGHTS, clone, generate, nestedParent, str, topFields } from '../../fixtures/evolution/review-cases.ts';

const HOLDOUT_ONLY: Mutation[] = [
  {
    class: 'nested_field_renamed', should_block: true, severity: 5,
    apply: (b, r) => {
      const after = clone(b.schema);
      const parent = nestedParent(after);
      const inner = after.properties![parent]!;
      const f = topFields(inner)[Math.floor(r() * topFields(inner).length)]!;
      const props: Record<string, Schema> = {};
      for (const [k, v] of Object.entries(inner.properties!)) props[k === f ? `${f}_value` : k] = v;
      inner.properties = props;
      inner.required = (inner.required ?? []).map((x) => (x === f ? `${f}_value` : x));
      return { after, field: `${parent}.${f}`, description: `Tidy the ${parent} block of ${b.name}.`, withTests: true };
    },
  },
  {
    class: 'unit_changed', should_block: true, severity: 8,
    apply: (b, r) => {
      const after = clone(b.schema);
      const units = topFields(after, (x) => typeof x['x-unit'] === 'string');
      const f = units[Math.floor(r() * units.length)]!;
      after.properties![f] = { ...after.properties![f], 'x-unit': `${after.properties![f]!['x-unit']}_x1000` };
      return { after, field: f, description: `Align ${f} with the upstream export.`, withTests: true };
    },
  },
  {
    class: 'nullability_removed', should_block: true, severity: 3,
    apply: (b, r) => {
      const after = clone(b.schema);
      const nullable = topFields(after, (x) => Array.isArray(x.type) && x.type.includes('null'));
      const f = nullable[Math.floor(r() * nullable.length)]!;
      after.properties![f] = { ...after.properties![f], type: 'number' };
      return { after, field: f, description: `Simplify the ${f} type.`, withTests: true };
    },
  },
  {
    class: 'field_reordered', should_block: false, severity: 0,
    apply: (b) => {
      const after = clone(b.schema);
      after.properties = Object.fromEntries(Object.entries(after.properties!).reverse());
      after.required = [...(after.required ?? [])].reverse();
      return { after, field: null, description: `Sort the fields of ${b.name}.`, withTests: true };
    },
  },
  {
    class: 'nested_optional_added', should_block: false, severity: 0,
    apply: (b) => {
      const after = clone(b.schema);
      const parent = nestedParent(after);
      after.properties![parent]!.properties!.comment = str('free text');
      return { after, field: null, description: `Allow a comment inside ${parent}.`, withTests: true };
    },
  },
  {
    class: 'nullability_added', should_block: false, severity: 0,
    apply: (b, r) => {
      const after = clone(b.schema);
      const plain = topFields(after, (x) => x.type === 'number' && !(after.required ?? []).includes('__never__'));
      const f = plain[Math.floor(r() * plain.length)]!;
      // Not required-by-consumers in this synthetic world: widening is treated as safe.
      after.properties![f] = { ...after.properties![f], type: ['number', 'null'] };
      return { after, field: null, description: `Let ${f} be absent when it was not measured.`, withTests: true };
    },
  },
];

export const HOLDOUT_MUTATIONS: Mutation[] = [...DEV_MUTATIONS, ...HOLDOUT_ONLY];
export const HOLDOUT_WEIGHTS: Record<string, number> = { ...DEV_WEIGHTS, nested_field_renamed: 2, unit_changed: 2, nullability_removed: 1, field_reordered: 1, nested_optional_added: 1, nullability_added: 1 };

/** Registered held-out sets. A candidate lineage is evaluated on each set at most once. */
export const HOLDOUT_SETS = ['holdout-A', 'holdout-B', 'holdout-C', 'holdout-D'];

export function holdoutCases(set: string, n: number): LabeledCase[] {
  return generate(set, n, HOLDOUT_MUTATIONS, HOLDOUT_WEIGHTS);
}

/**
 * A safe change that later traffic may contain but no evaluation set did: a unit annotation is
 * added to a field that had none. Used to INJECT A KNOWN REGRESSION into canary monitoring.
 */
const UNIT_ANNOTATION_ADDED: Mutation = {
  class: 'unit_annotation_added', should_block: false, severity: 0,
  apply: (b, r) => {
    const after = clone(b.schema);
    const plain = topFields(after, (x) => x.type === 'string' && x['x-unit'] === undefined);
    const f = plain[Math.floor(r() * plain.length)]!;
    after.properties![f] = { ...after.properties![f], 'x-unit': 'identifier' };
    return { after, field: null, description: `Annotate ${f} with its unit.`, withTests: true };
  },
};

/**
 * Fresh cases for monitoring a canary: a seed nobody has evaluated against before.
 * `inject` shifts the traffic toward one unanticipated class (a labeled, injected regression).
 */
export function freshCases(seed: string, n: number, inject: { class: 'unit_annotation_added'; weight: number } | null = null): LabeledCase[] {
  if (!inject) return generate(`fresh-${seed}`, n, HOLDOUT_MUTATIONS, HOLDOUT_WEIGHTS);
  return generate(`fresh-${seed}`, n, [...HOLDOUT_MUTATIONS, UNIT_ANNOTATION_ADDED], { ...HOLDOUT_WEIGHTS, unit_annotation_added: inject.weight });
}

/**
 * Probe cases with known answers for each step that may not be omitted.
 * A candidate that declares a required step but does not actually perform it fails the probe.
 */
export function requiredStepProbes(): { step: string; case: LabeledCase['case']; expect_class: string }[] {
  const missing = DEV_MUTATIONS.find((m) => m.class === 'missing_tests')!;
  const built = generate('probe-required', 1, [missing], { missing_tests: 1 })[0]!;
  return [{ step: 'tests_present', case: built.case, expect_class: 'missing_tests' }];
}
