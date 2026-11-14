// SYNTHETIC SCENARIO — scripted worker behaviors for the DETERMINISTIC FIXTURE PROVIDER.
// These stand in for model workers. They run in a real worker process under a real lease and write
// real files, but the *content* of the work is pre-authored. Nothing here is evidence about a model.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AcceptanceCriterion, WorkOutput } from '../../../src/contracts/types.ts';
import type { Behavior, BehaviorCtx } from '../../../src/providers/fixture-worker.ts';
import { decomposePlan, missionPlan } from './plan.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function done(summary: string, extra: Partial<WorkOutput> = {}): WorkOutput {
  return { status: 'completed', summary, artifacts: [], evidence: [], criteria_claims: [], remaining_uncertainty: [], questions: [], proposals: [], ...extra };
}

interface Req {
  id: string;
  stakeholder: string;
  team: string;
  text: string;
}

/** The scripted "analysis": which need each synthetic request expresses, and which criterion decides it. */
const ANALYSIS: Record<string, { need: string; symptom: string; criterion: AcceptanceCriterion }> = {
  'syn-req-001': {
    need: 'Know when a dataset is older than its own threshold, and be alerted before a review',
    symptom: 'A review dashboard silently showed three day old data',
    criterion: { criterion_id: 'AC-FRESH-PROPULSION', description: 'A dataset older than its own threshold is reported stale and raises an alert', verification_kind: 'executable', required_evidence_types: ['test_result'], mandatory: true, stakeholder: 'syn-ana-propulsion', check: { runner: 'acceptance-suite', target: 'acceptance' } },
  },
  'syn-req-002': {
    need: 'Detect schema drift against a declared contract and name the fields involved',
    symptom: 'A cost dashboard broke after an upstream column rename and nobody noticed',
    criterion: { criterion_id: 'AC-SCHEMA-SUPPLY', description: 'An upstream column rename is reported as schema drift naming the missing and unexpected fields', verification_kind: 'executable', required_evidence_types: ['test_result'], mandatory: true, stakeholder: 'syn-ben-supplychain', check: { runner: 'acceptance-suite', target: 'acceptance' } },
  },
  'syn-req-003': {
    need: 'An SLA report grouped by owner team that shows an unmeasured dataset as unknown',
    symptom: 'No trustworthy freshness view exists for the weekly operations review',
    criterion: { criterion_id: 'AC-SLA-QUALITY', description: 'The SLA report groups datasets by owner team and shows an unmeasured dataset as unknown, never as zero or fresh', verification_kind: 'executable', required_evidence_types: ['test_result'], mandatory: true, stakeholder: 'syn-chloe-quality', check: { runner: 'acceptance-suite', target: 'acceptance' } },
  },
  'syn-req-004': {
    need: 'One shared capability whose thresholds are policy configuration rather than code',
    symptom: 'Three engineers hand-rolled freshness checks with different thresholds',
    criterion: { criterion_id: 'AC-POLICY-FDE', description: 'Thresholds come from policy configuration; changing only the policy changes the result', verification_kind: 'executable', required_evidence_types: ['test_result'], mandatory: true, stakeholder: 'syn-dev-fde', check: { runner: 'acceptance-suite', target: 'acceptance' } },
  },
};

const SHARED_CRITERION: AcceptanceCriterion = { criterion_id: 'AC-CONTRACT', description: 'Every health record conforms to the pinned HealthRecord contract', verification_kind: 'executable', required_evidence_types: ['test_result'], mandatory: true, stakeholder: null, check: { runner: 'acceptance-suite', target: 'acceptance' } };

function fault(ctx: BehaviorCtx, name: string): boolean {
  return ctx.faults.includes(`defect:${name}`);
}

function edit(file: string, from: string | RegExp, to: string): void {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(from, to);
  if (after === before) throw new Error(`fixture defect did not apply to ${file}`);
  writeFileSync(file, after);
}

function implement(ctx: BehaviorCtx, part: 'engine' | 'report'): number {
  if (!ctx.workspace) throw new Error('coding task has no workspace');
  const contract = ctx.inputs['contract/health-record'] ? (JSON.parse(ctx.inputs['contract/health-record']) as { version: number }) : { version: 1 };
  cpSync(join(HERE, 'solutions', part, `c${contract.version}`), ctx.workspace, { recursive: true });
  return contract.version;
}

export const behaviors: Record<string, Behavior> = {
  'discovery.analyze': (ctx) => {
    const reqs = (JSON.parse(ctx.inputs['intake/requests'] ?? '{"requests":[]}') as { requests: Req[] }).requests;
    const related = reqs.filter((r) => ANALYSIS[r.id]);
    const unrelated = reqs.filter((r) => !ANALYSIS[r.id]);
    const report = {
      synthetic: true,
      shared_capability: 'A shared, policy-driven dataset-health capability: freshness against per-dataset thresholds and schema conformance against declared fields, with an SLA report and alerts',
      consolidated_request_ids: related.map((r) => r.id),
      unrelated_request_ids: unrelated.map((r) => r.id),
      distinct_needs: related.map((r) => ({ request_id: r.id, stakeholder: r.stakeholder, team: r.team, need: ANALYSIS[r.id]!.need })),
      symptoms: related.map((r) => ({ request_id: r.id, symptom: ANALYSIS[r.id]!.symptom })),
      underlying_problem: 'Dataset health is not observable in one place. Each team learns about staleness or drift only after a consumer breaks, and each has started solving it separately.',
      observed_facts: related.map((r) => `${r.id} (${r.team}) states: "${r.text}"`),
      interpretations: ['The consolidated requests can be served by one capability. This is an interpretation: lexical overlap nominated it and the stakeholders have not confirmed it.', ...(unrelated.length ? [`${unrelated.map((r) => r.id).join(', ')} concerns licensing and is not part of this need.`] : [])],
      unknowns: ['Actual load cadences are not given; thresholds are taken from the requests where stated', 'Whether an alert should page someone or only appear in a report is not stated', 'No request says how long drift may persist before it matters'],
    };
    return done(`Consolidated ${related.length} of ${reqs.length} requests into one shared need; ${unrelated.length} left out as unrelated`, {
      artifacts: [{ key: 'discovery/overlap-report', kind: 'report', media_type: 'application/json', content: JSON.stringify(report, null, 2) }],
      evidence: [
        ...report.observed_facts.map((f) => ({ kind: 'source_excerpt', statement: f, epistemic: 'observed_fact' as const, origin: 'business' as const, refs: ['intake/requests'] })),
        ...report.interpretations.map((i) => ({ kind: 'analysis', statement: i, epistemic: 'interpretation' as const, origin: 'agent' as const, refs: [] })),
      ],
      remaining_uncertainty: report.unknowns,
      // An unknown only a person can settle is asked, not assumed.
      questions: [{ to: 'chief_of_staff', question: 'Should a stale-data alert page someone, or only appear in the report? No request says.', blocking: false }],
    });
  },

  'planning.criteria': (ctx) => {
    const report = JSON.parse(ctx.inputs['discovery/overlap-report'] ?? '{}') as { distinct_needs: { request_id: string; stakeholder: string; need: string }[] };
    let needs = report.distinct_needs;
    // INJECTED DEFECT: silently drop one stakeholder's need while consolidating.
    if (fault(ctx, 'drop_need')) needs = needs.slice(0, -1);
    const criteria = [...needs.map((n) => ANALYSIS[n.request_id]!.criterion), SHARED_CRITERION];
    const doc = {
      synthetic: true,
      outcome: 'Any team can see, from one policy-driven capability, which datasets are stale, drifting or unmeasured, and who owns them.',
      criteria,
      needs_map: needs.map((n) => ({ request_id: n.request_id, stakeholder: n.stakeholder, need: n.need, criterion_id: ANALYSIS[n.request_id]!.criterion.criterion_id })),
      deferred_needs: [] as { stakeholder: string; reason: string }[],
    };
    return done(`Defined ${criteria.length} measurable acceptance criteria covering ${needs.length} stakeholder needs`, {
      artifacts: [{ key: 'plan/acceptance-criteria', kind: 'plan', media_type: 'application/json', content: JSON.stringify(doc, null, 2) }],
      remaining_uncertainty: ['Thresholds in the criteria come from the requests and have not been confirmed by dataset owners'],
    });
  },

  'planning.contract': (ctx) => {
    const version = ctx.store.getMeta<number>(`mission:${ctx.mission.id}:contract_version`) ?? 1;
    const content = readFileSync(join(HERE, 'contracts', `health-record.v${version}.json`), 'utf8');
    return done(`Defined HealthRecord contract version ${version} as the interface both workstreams pin`, {
      artifacts: [{ key: 'contract/health-record', kind: 'contract', media_type: 'application/json', content }],
      remaining_uncertainty: ['The contract carries no severity ranking; the weekly review may want one'],
    });
  },

  'planning.plan': (ctx) => {
    const criteria = (JSON.parse(ctx.inputs['plan/acceptance-criteria'] ?? '{"criteria":[]}') as { criteria: AcceptanceCriterion[] }).criteria;
    const plan = missionPlan(ctx.coordination, criteria);
    return done(`Proposed a ${plan.topology} organization: ${plan.swarms.map((s) => s.archetype).join(', ')} with ${plan.tasks.length} tasks`, {
      artifacts: [{ key: 'plan/work-graph', kind: 'plan', media_type: 'application/json', content: JSON.stringify(plan, null, 2) }],
      plan,
    });
  },

  'delivery.decompose': (ctx) => {
    const plan = decomposePlan(ctx.coordination);
    return done(`Proposed ${plan.swarms.length} subordinate teams meeting at ${plan.interface_agreements[0]?.artifact_key ?? 'integration'}`, {
      artifacts: [{ key: 'plan/delivery-decomposition', kind: 'plan', media_type: 'application/json', content: JSON.stringify(plan, null, 2) }],
      plan,
    });
  },

  'delivery.engine.implement': (ctx) => {
    const v = implement(ctx, 'engine');
    const file = join(ctx.workspace!, 'src/engine/evaluate.ts');
    // INJECTED DEFECT: hard-code the default threshold. The worker's own unit tests still pass.
    if (fault(ctx, 'ignores_policy_default')) edit(file, 'policy.freshness_threshold_minutes ?? policies.default.freshness_threshold_minutes', 'policy.freshness_threshold_minutes ?? 1440');
    return done(`Implemented the evaluation engine against contract version ${v}`, {
      criteria_claims: [{ criterion_id: 'U-ENGINE', claimed: 'met', note: 'wrote unit tests; the runtime runs them' }],
      remaining_uncertainty: ['Drift detection compares declared and observed type names literally'],
    });
  },

  'delivery.report.implement': (ctx) => {
    const v = implement(ctx, 'report');
    const src = join(ctx.workspace!, 'src/report/report.ts');
    const test = join(ctx.workspace!, 'test/report/report.test.ts');
    // INJECTED DEFECT: read a field name the contract does not define. The worker's own tests use the
    // same wrong name, so they pass; only the integration boundary exposes it.
    if (fault(ctx, 'field_mismatch')) {
      for (const f of [src, test]) writeFileSync(f, readFileSync(f, 'utf8').replaceAll('staleness_minutes', 'staleness_min'));
    }
    // INJECTED DEFECT: show an unmeasured value as zero, and leave the case untested.
    if (fault(ctx, 'unknown_as_zero')) {
      edit(src, "return n === null ? '—' : String(n);", "return n === null ? '0' : String(n);");
      edit(test, /test\('an unmeasured dataset is shown[\s\S]*?\n}\);\n\n/, '');
    }
    return done(`Implemented the SLA report and alerts against contract version ${v}`, {
      criteria_claims: [{ criterion_id: 'U-REPORT', claimed: 'met', note: 'wrote unit tests; the runtime runs them' }],
    });
  },

  'reliability.knowledge': (ctx) => {
    const contract = JSON.parse(ctx.inputs['contract/health-record'] ?? '{"version":1}') as { version: number };
    const failures = ctx.store.observations.where('"mission_id" = ?', ctx.mission.id).filter((o) => ['rework', 'integration_failure', 'acceptance_failure'].includes(o.kind));
    const notes = [
      { kind: 'fact', statement: 'Four synthetic teams asked for dataset freshness or schema checks within two days; one shared capability covers all four needs.', scope: ['scenario:shared-capability', 'archetype:discovery'], source_refs: ['discovery/overlap-report'], certainty: 'verified', fresh_for_days: 30 },
      { kind: 'decision', statement: `The engine and the report meet at HealthRecord contract version ${contract.version}; both pin it before implementation.`, scope: ['scenario:shared-capability', 'archetype:planning', 'archetype:delivery'], source_refs: ['contract/health-record'], certainty: 'verified', fresh_for_days: 90 },
      { kind: 'procedure', statement: 'Pin the shared record as a versioned contract artifact before starting parallel producer and consumer workstreams, then verify the merged result against that contract.', scope: ['archetype:planning', 'archetype:delivery', 'pattern:producer-consumer'], source_refs: ['plan/work-graph', 'contract/health-record'], certainty: 'untested', fresh_for_days: 180 },
      ...failures.map((o) => ({ kind: 'failed_approach', statement: `${o.failure_class}: ${String((o.details as { reason?: string }).reason ?? o.kind)}`.slice(0, 400), scope: ['scenario:shared-capability', `component:${o.component ?? 'unknown'}`], source_refs: [o.id], certainty: o.certainty, fresh_for_days: 60 })),
    ];
    const doc = {
      synthetic: true,
      notes,
      skill_candidate: {
        id: 'producer-consumer-contract-first',
        title: 'Agree a versioned record contract before parallel producer and consumer work',
        prerequisites: ['Two workstreams exchange one record type', 'Acceptance criteria exist'],
        supported_situations: ['A producer and a consumer can be built independently once their record is fixed'],
        procedure: ['Write the record as a versioned schema', 'Pin its exact version in both workstreams', 'Merge one workstream at a time', 'Run a test at the boundary that validates produced records against the schema and feeds them to the consumer'],
        expected_outputs: ['A contract artifact', 'Two branches', 'A passing boundary test'],
        verification: ['The boundary test passes on the merged result', 'An independent acceptance suite passes'],
        known_failure_cases: failures.map((o) => o.failure_class),
        status: 'untested',
      },
    };
    return done(`Recorded ${notes.length} scoped notes and one candidate skill`, {
      artifacts: [{ key: 'knowledge/mission-notes', kind: 'report', media_type: 'application/json', content: JSON.stringify(doc, null, 2) }],
    });
  },
};
