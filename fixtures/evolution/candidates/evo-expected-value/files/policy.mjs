// Improvement policy v2 — "expected value".
//
// Same interface as v1: decide(state) -> action. What changes is the improvement process itself:
//   - problems are valued by VERIFIED failures x severity, not by how often something is reported
//   - a built fix is piloted on observed cases before budget is spent on a held-out evaluation
//   - a fix whose pilot breaks working cases, or fixes nothing, is dropped
//   - the campaign stops when no remaining step is worth its cost
export const id = 'expected-value';

const PRIOR_SUCCESS = 0.55;
const PILOT_CASES = 12;
const MIN_VALUE_PER_UNIT = 0.01;

export function decide(state) {
  const budget = state.budget_remaining;
  const submit = state.costs.submit;
  const open = new Map(state.problems.filter((p) => !p.resolved).map((p) => [p.id, p]));
  const value = (c) => c.problem_ids.reduce((a, id) => a + (open.has(id) ? open.get(id).verified_count * open.get(id).severity : 0), 0);

  let best = null;
  const consider = (score, action) => {
    if (best === null || score > best.score) best = { score, action };
  };
  for (const c of state.candidates) {
    if (c.submitted) continue;
    const v = value(c);
    if (v <= 0) continue; // nothing verified to gain
    if (c.built && c.pilot) {
      if (c.pilot.broke > 0 || c.pilot.fixed === 0) continue; // the pilot says do not pay for a held-out run
      if (submit > budget) continue;
      const p = (c.pilot.fixed + 1) / (c.pilot.attempted + 2);
      consider((p * v) / submit + 1000, { type: 'submit', candidate_id: c.id }); // finish what is nearly done first
    } else if (c.built) {
      if (PILOT_CASES + submit > budget) continue;
      consider((PRIOR_SUCCESS * v) / (PILOT_CASES + submit) + 500, { type: 'pilot', candidate_id: c.id, cases: PILOT_CASES });
    } else {
      const cost = c.build_cost + PILOT_CASES + submit;
      if (cost > budget) continue;
      const score = (PRIOR_SUCCESS * v) / cost;
      if (score < MIN_VALUE_PER_UNIT) continue; // not worth starting
      consider(score, { type: 'build', candidate_id: c.id });
    }
  }
  return best ? best.action : { type: 'stop', reason: 'no remaining step is worth its cost' };
}
