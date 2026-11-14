// Improvement policy v1 — "frequency first".
//
// decide(state) is called repeatedly during an improvement campaign and returns the next action.
//   state.budget_remaining  experiment units left
//   state.costs             { pilot_per_case, submit }
//   state.problems          [{ id, observed_count, verified_count, severity, resolved }]
//                           observed_count counts every report; verified_count only checked failures
//   state.candidates        [{ id, problem_ids, build_cost, built, pilot, submitted, result }]
// Actions: { type: 'build' | 'submit', candidate_id } | { type: 'pilot', candidate_id, cases } | { type: 'stop', reason }
export const id = 'frequency-first';

export function decide(state) {
  const open = state.problems.filter((p) => !p.resolved).sort((a, b) => b.observed_count - a.observed_count || a.id.localeCompare(b.id));
  for (const problem of open) {
    const next = state.candidates.find((c) => c.problem_ids.includes(problem.id) && !c.submitted);
    if (!next) continue; // nothing left to try for this problem
    if (!next.built) {
      if (next.build_cost > state.budget_remaining) continue;
      return { type: 'build', candidate_id: next.id };
    }
    if (state.costs.submit > state.budget_remaining) continue;
    return { type: 'submit', candidate_id: next.id };
  }
  return { type: 'stop', reason: 'no affordable step remains' };
}
