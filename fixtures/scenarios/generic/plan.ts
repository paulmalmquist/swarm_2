import type { Mission, PlanProposal } from '../../../src/contracts/types.ts';

/** One agent for tightly coupled or straightforward work. */
export function bootstrapPlan(ctx: { mission: Mission }): PlanProposal {
  return {
    topology: 'single',
    anchor: 'mission',
    rationale: 'A single objective with no stated interfaces: one agent is the smallest organization that fits.',
    swarms: [{ ref: 'work', archetype: 'delivery', parent_ref: null, purpose: ctx.mission.title, deliverable: 'A written result for the objective', stopping_condition: 'The result is accepted, or the reservation is exhausted', budget_share: 0.5, temporary: false, depends_on: [] }],
    tasks: [
      {
        ref: 'work.do',
        swarm_ref: 'work',
        title: ctx.mission.title,
        objective: ctx.mission.objective,
        executor: 'worker',
        role: 'generalist',
        depends_on: [],
        verifies: [],
        input_keys: [],
        outputs: [{ key: 'result/summary', kind: 'report', description: 'The result' }],
        params: {},
        acceptance_criteria: [{ criterion_id: 'G-RESULT', description: 'A non-empty result is produced for the objective', verification_kind: 'inspection', required_evidence_types: ['inspection'], mandatory: true, stakeholder: null, check: { runner: 'inspect:nonempty', target: 'result/summary' } }],
        verification: { method: 'executable', independent: true },
        write_scope: [],
        budget_share: 0.8,
        budget_class: 'delivery',
        competing_group: null,
        risk_tier: 'low',
      },
    ],
    interface_agreements: [],
    extra_dependencies: [],
  };
}
