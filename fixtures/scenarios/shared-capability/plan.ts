// SYNTHETIC SCENARIO — plan templates for the shared-capability mission.
// These are what mission coordination proposes. Every proposal is validated by the runtime
// before anything is created; the coordination policy of the mission's pinned release shapes them.
import type { CoordinationDef } from '../../../src/contracts/definitions.ts';
import type { AcceptanceCriterion, Mission, PlanProposal } from '../../../src/contracts/types.ts';

type PlanTask = PlanProposal['tasks'][number];

function task(t: Partial<PlanTask> & Pick<PlanTask, 'ref' | 'swarm_ref' | 'title' | 'objective' | 'role'>): PlanTask {
  return {
    executor: 'worker',
    depends_on: [],
    verifies: [],
    input_keys: [],
    outputs: [],
    params: {},
    acceptance_criteria: [],
    verification: { method: 'executable', independent: true },
    write_scope: [],
    budget_share: 0.2,
    budget_class: 'delivery',
    competing_group: null,
    risk_tier: 'low',
    ...t,
  };
}

function inspect(id: string, description: string, inspector: string, target: string): AcceptanceCriterion {
  return { criterion_id: id, description, verification_kind: 'inspection', required_evidence_types: ['inspection'], mandatory: true, stakeholder: null, check: { runner: `inspect:${inspector}`, target } };
}

/** First plan: activate discovery and planning. Delivery is planned only once the need is understood. */
export function bootstrapPlan(ctx: { mission: Mission; defs: { coordination: CoordinationDef } }): PlanProposal {
  const shares = ctx.defs.coordination.budget_shares;
  // Without an explicit interface agreement there is no contract step: one fewer task before delivery starts.
  const agreed = ctx.defs.coordination.decomposition.interface_agreement_before_parallel;
  const plan: PlanProposal = {
    topology: 'hierarchical',
    anchor: 'mission',
    rationale: 'The objective comes from several requests whose shared need is not yet established, so discovery runs first and planning follows it.',
    swarms: [
      { ref: 'discovery', archetype: 'discovery', parent_ref: null, purpose: 'Establish what the requests have in common and what each stakeholder distinctly needs', deliverable: 'An overlap report separating observed facts from interpretation', stopping_condition: 'The report is accepted, or the reservation is exhausted', budget_share: shares.discovery ?? 0.12, temporary: false, depends_on: [] },
      { ref: 'planning', archetype: 'planning', parent_ref: null, purpose: 'Turn the understood need into acceptance criteria, an agreed interface and an executable plan', deliverable: 'Acceptance criteria, a pinned interface contract and a validated work graph', stopping_condition: 'The work graph is accepted and materialized, or the reservation is exhausted', budget_share: shares.planning ?? 0.2, temporary: false, depends_on: ['discovery'] },
    ],
    tasks: [
      task({
        ref: 'discovery.analyze',
        swarm_ref: 'discovery',
        role: 'analyst',
        title: 'Analyze the requests for overlap and distinct needs',
        objective: 'Identify the shared underlying need behind the requests, keep each stakeholder\'s distinct need, separate symptoms from the underlying problem, and name what is unknown.',
        input_keys: ['intake/requests'],
        // The same analysis of the same requests need not be repeated in another mission.
        params: {
          reuse_capability: 'request-overlap-analysis',
          output_format:
            'Put one JSON document under the key discovery/overlap-report with exactly these fields: shared_capability (one sentence naming the single capability that would serve the overlapping requests); consolidated_request_ids (ids of the requests that share that need); unrelated_request_ids (ids that do not belong, possibly empty); distinct_needs (one object per consolidated request: request_id, stakeholder, team, need — the need in that stakeholder\'s own terms, not merged with the others); symptoms (objects: request_id, symptom); underlying_problem (one or two sentences); observed_facts (strings: only what a request literally states, citing its id); interpretations (strings: what you infer, marked as inference); unknowns (strings: what no request states and somebody must decide). If an unknown can only be settled by a person, also ask it in questions[] addressed to chief_of_staff.',
        },
        outputs: [{ key: 'discovery/overlap-report', kind: 'report', description: 'JSON overlap report' }],
        acceptance_criteria: [
          inspect('D-OVERLAP', 'Names the shared capability and lists a distinct need for every request it consolidates', 'overlap_report', 'discovery/overlap-report'),
          inspect('D-EPISTEMICS', 'Separates observed facts from interpretations and names unknowns', 'epistemics', 'discovery/overlap-report'),
        ],
        budget_share: 0.9,
      }),
      task({
        ref: 'planning.criteria',
        swarm_ref: 'planning',
        role: 'architect',
        title: 'Define outcomes and measurable acceptance criteria',
        objective: 'Write one measurable acceptance criterion for every distinct stakeholder need, plus any shared criterion, each with a way to verify it.',
        input_keys: ['discovery/overlap-report'],
        params: {
          output_format:
            'Put one JSON document under the key plan/acceptance-criteria with these fields: outcome (one sentence); criteria (array of objects: criterion_id, description, verification_kind — always "executable", stakeholder — the stakeholder id the criterion serves, or null for a shared criterion); needs_map (one object per stakeholder need in the overlap report: request_id, stakeholder, need, criterion_id); deferred_needs (objects: stakeholder, reason — only for a need you deliberately leave out, otherwise an empty array). Each description must be measurable: say what is observed and what result counts as passing, including any threshold or exact wording a request gives.',
          // The verification swarm owns the executable acceptance suite and assigns the ids its tests answer to.
          criterion_ids_assigned_by_verification: agreed
            ? { 'syn-req-001': 'AC-FRESH-PROPULSION', 'syn-req-002': 'AC-SCHEMA-SUPPLY', 'syn-req-003': 'AC-SLA-QUALITY', 'syn-req-004': 'AC-POLICY-FDE', '(shared: every record conforms to the agreed interface)': 'AC-CONTRACT' }
            : { 'syn-req-001': 'AC-FRESH-PROPULSION', 'syn-req-002': 'AC-SCHEMA-SUPPLY', 'syn-req-003': 'AC-SLA-QUALITY', 'syn-req-004': 'AC-POLICY-FDE' },
        },
        outputs: [{ key: 'plan/acceptance-criteria', kind: 'plan', description: 'JSON acceptance criteria mapped to stakeholder needs' }],
        acceptance_criteria: [inspect('P-CRITERIA', 'Every stakeholder need maps to a criterion or is explicitly deferred with a reason', 'criteria', 'plan/acceptance-criteria')],
        budget_share: 0.3,
      }),
      task({
        ref: 'planning.contract',
        swarm_ref: 'planning',
        role: 'architect',
        title: 'Agree the HealthRecord interface',
        objective: 'Define the record that the evaluation engine produces and the report consumes, as a versioned contract both workstreams will pin.',
        depends_on: ['planning.criteria'],
        input_keys: ['plan/acceptance-criteria'],
        // The scenario supplies its reference contract; in a live mission this step stays scripted and is labeled so.
        params: { execution: 'template' },
        outputs: [{ key: 'contract/health-record', kind: 'contract', description: 'Versioned JSON schema for HealthRecord' }],
        acceptance_criteria: [inspect('P-CONTRACT', 'The contract is a versioned schema with required fields for freshness and schema status', 'contract', 'contract/health-record')],
        budget_share: 0.3,
      }),
      task({
        ref: 'planning.plan',
        swarm_ref: 'planning',
        role: 'planner',
        title: 'Propose the work graph',
        objective: 'Propose the organization and work graph: which swarms activate, how the work divides, where it integrates and how it is verified.',
        depends_on: [agreed ? 'planning.contract' : 'planning.criteria'],
        // The plan depends on the criteria and on the interface existing, not on the interface's content.
        input_keys: ['plan/acceptance-criteria'],
        // The work graph comes from the versioned coordination policy, not from a model.
        params: { execution: 'template' },
        outputs: [{ key: 'plan/work-graph', kind: 'plan', description: 'The proposed plan, as proposed' }],
        acceptance_criteria: [inspect('P-PLAN', 'A plan is proposed and recorded', 'nonempty', 'plan/work-graph')],
        budget_share: 0.3,
      }),
    ],
    interface_agreements: [],
    extra_dependencies: [],
  };
  if (!agreed) plan.tasks = plan.tasks.filter((t) => t.ref !== 'planning.contract');
  return plan;
}

/** Mission coordination's proposal for delivery, verification, knowledge capture and review. */
export function missionPlan(policy: CoordinationDef, criteria: AcceptanceCriterion[]): PlanProposal {
  const shares = policy.budget_shares;
  // Whether a separate swarm verifies the integrated result is a coordination-policy choice,
  // so it can be changed by a coordination-level candidate and tested.
  const independent = policy.reviewer_assignment.independent_verification;
  const agreed = policy.decomposition.interface_agreement_before_parallel;
  const plan: PlanProposal = {
    topology: 'hierarchical',
    anchor: 'mission',
    rationale:
      'Two implementation workstreams are independent once the interface is pinned, so they run in parallel under a delivery swarm and meet at one integration task. Verification is a separate swarm so nobody verifies their own work.',
    swarms: [
      { ref: 'delivery', archetype: 'delivery', parent_ref: null, purpose: 'Build the shared dataset-health capability', deliverable: 'An integrated, tested capability on the integration branch', stopping_condition: 'The integrated result is independently accepted, or the reservation is exhausted', budget_share: shares.delivery ?? 0.6, temporary: false, depends_on: ['planning'] },
      ...(independent ? [{ ref: 'verification', archetype: 'verification' as const, parent_ref: null, purpose: 'Independently verify the integrated result against the acceptance criteria', deliverable: 'A verdict per acceptance criterion with evidence', stopping_condition: 'Every criterion has a verdict for the current result', budget_share: shares.verification ?? 0.8, temporary: false, depends_on: [] }] : []),
      { ref: 'reliability', archetype: 'reliability', parent_ref: null, purpose: 'Preserve what this mission learned with provenance', deliverable: 'Scoped memories and a candidate skill', stopping_condition: 'Knowledge notes are accepted', budget_share: shares.reliability ?? 0.4, temporary: false, depends_on: [] },
    ],
    tasks: [
      task({
        ref: 'delivery.decompose',
        swarm_ref: 'delivery',
        role: 'lead',
        title: 'Decide how to divide the implementation',
        objective: 'Decide whether the implementation justifies subordinate teams, and if so give each a bounded purpose, budget, deliverable and stopping condition.',
        input_keys: ['plan/acceptance-criteria'],
        // The decomposition also comes from the coordination policy.
        params: { execution: 'template' },
        outputs: [{ key: 'plan/delivery-decomposition', kind: 'plan', description: 'The delivery lead\'s decomposition, as proposed' }],
        acceptance_criteria: [inspect('L-DECOMP', 'A decomposition is proposed and recorded', 'nonempty', 'plan/delivery-decomposition')],
        budget_share: 0.06,
      }),
      task({
        ref: 'delivery.integrate',
        swarm_ref: 'delivery',
        role: 'integrator',
        executor: 'runtime:integrate',
        title: 'Integrate the workstreams',
        objective: 'Merge the accepted workstreams one at a time and verify the combined result at the interface boundary.',
        depends_on: ['delivery.decompose'],
        // The exact workstream commits being integrated are pinned like any other input.
        input_keys: ['code/engine', 'code/report'],
        outputs: [{ key: 'code/integrated', kind: 'code', description: 'The integrated capability' }],
        // Without a verification swarm nobody checks these criteria independently; they stay recorded as unverified.
        acceptance_criteria: independent ? criteria : criteria.map((c) => ({ ...c, mandatory: false })),
        verification: { method: 'executable', independent },
        params: {
          merge_order: ['delivery.engine.implement', 'delivery.report.implement'],
          component_tests: { 'delivery.engine.implement': 'test/engine/**/*.test.ts', 'delivery.report.implement': 'test/report/**/*.test.ts' },
          final_checks: ['test/**/*.test.ts'],
          attribution: { 'engine:': 'delivery.engine.implement', 'report:': 'delivery.report.implement' },
          output_key: 'code/integrated',
        },
        budget_share: 0.1,
      }),
      task({
        ref: 'verification.acceptance',
        swarm_ref: 'verification',
        role: 'verifier',
        executor: 'runtime:verify',
        title: 'Run the protected acceptance suite on the integrated result',
        objective: 'Verify every acceptance criterion against a clean checkout of the integrated result, using checks the delivery workers never saw.',
        verifies: ['delivery.integrate'],
        verification: { method: 'none', independent: false },
        params: {
          artifact_key: 'code/integrated',
          attribution: { 'AC-FRESH-PROPULSION': 'delivery.engine.implement', 'AC-SCHEMA-SUPPLY': 'delivery.engine.implement', 'AC-SLA-QUALITY': 'delivery.report.implement', 'AC-POLICY-FDE': 'delivery.engine.implement', 'AC-CONTRACT': 'delivery.engine.implement' },
        },
        budget_class: 'verification',
        budget_share: 0.5,
      }),
      task({
        ref: 'reliability.knowledge',
        swarm_ref: 'reliability',
        role: 'librarian',
        title: 'Capture what this mission established',
        objective: 'Record reusable facts, decisions and a candidate procedure from this mission, each with provenance, scope and a way to invalidate it.',
        depends_on: ['delivery.integrate'],
        input_keys: agreed ? ['discovery/overlap-report', 'plan/acceptance-criteria', 'contract/health-record'] : ['discovery/overlap-report', 'plan/acceptance-criteria'],
        params: {
          output_format:
            'Put one JSON document under the key knowledge/mission-notes with a field notes: an array of objects, each with kind (one of fact, interpretation, decision, procedure, failed_approach), statement (one or two sentences that will still make sense out of context), scope (array of strings saying where it applies, for example "scenario:shared-capability" or "archetype:delivery"), source_refs (array naming the input artifact keys the note rests on, never empty), certainty (verified, suspected or untested — a procedure is untested until it has worked again elsewhere) and fresh_for_days (a number). Record only what the inputs support.',
        },
        outputs: [{ key: 'knowledge/mission-notes', kind: 'report', description: 'JSON knowledge notes' }],
        acceptance_criteria: [inspect('K-PROVENANCE', 'Every note states its kind, scope and source', 'knowledge', 'knowledge/mission-notes')],
        budget_class: 'completion',
        budget_share: 0.6,
      }),
      task({
        ref: 'review.packet',
        swarm_ref: '(mission)',
        role: 'mission-coordinator',
        executor: 'runtime:review_packet',
        title: 'Prepare the review packet',
        objective: 'Assemble context, exact changes, acceptance evidence, remaining concerns and the decision being requested.',
        depends_on: independent ? ['delivery', 'verification', 'reliability'] : ['delivery', 'reliability'],
        outputs: [
          { key: 'review/packet', kind: 'review_packet', description: 'Review packet (JSON)' },
          { key: 'review/packet.md', kind: 'review_packet', description: 'Review packet (readable)' },
        ],
        verification: { method: 'none', independent: false },
        budget_class: 'completion',
        budget_share: shares.review ?? 0.3,
      }),
    ],
    interface_agreements: [],
    extra_dependencies: [],
  };
  if (!independent) plan.tasks = plan.tasks.filter((t) => t.ref !== 'verification.acceptance');
  return plan;
}

/** The delivery lead's decomposition into two subordinate teams that meet at the pinned interface. */
export function decomposePlan(policy: CoordinationDef): PlanProposal {
  const pinned = policy.decomposition.interface_agreement_before_parallel;
  const coder = (ref: string, team: string, what: string, dir: string, share: number): PlanTask =>
    task({
      ref,
      swarm_ref: team,
      role: 'implementer',
      title: `Implement the ${what}`,
      objective: `Implement the ${what} in src/${dir} with unit tests in test/${dir}, against the pinned HealthRecord contract.`,
      // Without an explicit interface agreement each workstream works from the prose criteria alone.
      input_keys: pinned ? ['contract/health-record', 'plan/acceptance-criteria'] : ['plan/acceptance-criteria'],
      params: {
        guidance: `Before writing anything, read README.md, data/, contracts/ and test/integration/ in the working directory. The integration test shows the module paths and exported function names the other workstream and the integration step rely on; keep to them exactly. Put your code only under src/${dir}/ and your own tests only under test/${dir}/. Run your tests with exactly this command, as a command on its own: node --test test/${dir}/*.test.ts — and make them pass before you finish. Shell commands other than node --test are not available to you; use the file tools for everything else. The acceptance criteria you were given are checked afterwards by tests you cannot see.`,
      },
      outputs: [{ key: `code/${dir}`, kind: 'code', description: `src/${dir} and its tests` }],
      acceptance_criteria: [{ criterion_id: `U-${dir.toUpperCase()}`, description: `The ${what} passes its own unit tests`, verification_kind: 'executable', required_evidence_types: ['test_result'], mandatory: true, stakeholder: null, check: { runner: 'node-test', target: `test/${dir}/**/*.test.ts` } }],
      write_scope: [`src/${dir}/**`, `test/${dir}/**`],
      budget_share: share,
    });
  return {
    topology: 'hierarchical',
    anchor: 'own_swarm',
    rationale: 'The engine and the report share nothing but the record between them, so two small teams can work at the same time and meet at integration.',
    swarms: [
      { ref: 'delivery.engine', archetype: 'delivery', parent_ref: null, purpose: 'Implement the evaluation engine that produces HealthRecords', deliverable: 'src/engine with passing unit tests on its own branch', stopping_condition: 'Unit tests pass and the branch is accepted, or the reservation is exhausted', budget_share: 0.4, temporary: true, depends_on: [] },
      { ref: 'delivery.report', archetype: 'delivery', parent_ref: null, purpose: 'Implement the SLA report and alerts that consume HealthRecords', deliverable: 'src/report with passing unit tests on its own branch', stopping_condition: 'Unit tests pass and the branch is accepted, or the reservation is exhausted', budget_share: 0.4, temporary: true, depends_on: [] },
    ],
    tasks: [coder('delivery.engine.implement', 'delivery.engine', 'evaluation engine', 'engine', 0.9), coder('delivery.report.implement', 'delivery.report', 'SLA report and alerts', 'report', 0.9)],
    interface_agreements: pinned ? [{ artifact_key: 'contract/health-record', between: ['delivery.engine.implement', 'delivery.report.implement'] }] : [],
    extra_dependencies: [{ task_key: 'delivery.integrate', depends_on: ['delivery.engine', 'delivery.report'] }],
  };
}
