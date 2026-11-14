import type { ImprovementReceipt, ReleaseManifest } from '../contracts/types.ts';

const BASIS: Record<string, string> = {
  fixture: 'DETERMINISTIC FIXTURE EVALUATION — executable checks on synthetic cases; no model was run',
  simulation: 'SIMULATION — a synthetic testbed; results describe the testbed, not real work',
  live: 'LIVE MODEL EXECUTION',
};

const fmt = (n: number | null): string => (n === null ? '—' : String(n));
const ci = (c: [number, number] | null): string => (c ? `${c[0]} to ${c[1]}` : '—');

/** A readable improvement receipt. An unmeasured value is shown as a dash, never as zero. */
export function renderReceipt(r: ImprovementReceipt): string {
  const lines: string[] = [];
  lines.push(`# Improvement receipt ${r.receipt_id}`, '', `> ${BASIS[r.evidence_basis] ?? r.evidence_basis}`, '');
  lines.push(`**Decision: ${r.decision.toUpperCase()}** — ${r.justification}`, '');
  if (r.authorship) lines.push(`Candidate written by: ${r.authorship.kind === 'model' ? `a model (${r.authorship.model ?? 'not recorded'})` : 'a script'}. The evidence basis below describes how it was judged, not who wrote it.`, '');
  lines.push(`Decided by ${r.decided_by} at ${r.decided_at}. Level: ${r.level}. Experiment: \`${r.experiment_id}\`.`, '');
  lines.push('## Problem and supporting observations', '', r.problem.statement, '', `Verified failure observations cited: ${r.problem.observed_failure_count}${r.problem.observation_ids.length ? ` (for example \`${r.problem.observation_ids.slice(0, 3).join('`, `')}\`)` : ''}.`, '');
  lines.push('## Hypothesis', '', r.hypothesis, '', `Expected benefit: ${r.expected_benefit}`, '', 'Possible regressions stated in advance:', ...r.possible_regressions.map((p) => `- ${p}`), '');
  lines.push('## Parent version and exact change', '', `Parent: ${r.parent.component} v${r.parent.version} (\`${r.parent.content_hash.slice(0, 16)}\`). Candidate: \`${r.change.candidate_hash.slice(0, 16)}\`.`, '', r.change.summary, '', '| File | Before | After |', '|---|---|---|', ...r.change.files.map((f) => `| ${f.path} | ${f.before_hash ? f.before_hash.slice(0, 12) : 'new'} | ${f.after_hash ? f.after_hash.slice(0, 12) : 'removed'} |`), '');
  lines.push('## Evaluation', '', `- Protocol: ${r.evaluation.protocol_id}, frozen at ${r.evaluation.frozen_at}, before the candidate was submitted`, `- Policy hash: \`${r.evaluation.policy_hash.slice(0, 16)}\``, `- Workload: ${r.evaluation.workload_refs.join('; ')}`, `- Held-out set: ${r.evaluation.holdout_set}`, `- Executor: ${r.evaluation.executor} (${r.evaluation.deterministic ? 'deterministic' : 'stochastic'}; ${r.evaluation.execution_kind}; ${r.evaluation.repeats} pass)`, '');
  lines.push('### Attempts', '', '| # | Kind | Cases | Note |', '|---|---|---|---|', ...r.attempts.map((a) => `| ${a.attempt_no} | ${a.kind} | ${a.cases} | ${a.note} |`), '');
  lines.push(`Resource use: ${r.resource_use.experiment_units} experiment units, ${r.resource_use.wall_ms} ms, ${r.resource_use.model_calls} model calls, cost ${r.resource_use.cost_usd_est === null ? 'not measured' : `${r.resource_use.cost_usd_est} USD (estimate)`}.`, '');
  lines.push('## Outcome differences and uncertainty', '', '| Metric | Candidate | Incumbent | Baseline | Difference vs incumbent | 95% interval | n |', '|---|---|---|---|---|---|---|');
  for (const c of r.comparisons) lines.push(`| ${c.metric} (${c.higher_is_better ? 'higher' : 'lower'} is better) | ${fmt(c.candidate)} | ${fmt(c.incumbent)} | ${fmt(c.baseline)} | ${fmt(c.diff_vs_incumbent)} | ${ci(c.ci95_vs_incumbent)} | ${c.n} |`);
  if (r.comparisons[0]) lines.push('', `Method for the primary metric: ${r.comparisons[0].method}.`);
  lines.push('', '## Gates', '', '| Gate | Kind | Verdict | Meaning |', '|---|---|---|---|', ...r.gates.map((g) => `| ${g.name} | ${g.kind} | ${g.verdict} | ${g.meaning} |`), '');
  lines.push('## Known regressions', '', ...(r.known_regressions.length ? r.known_regressions.map((k) => `- ${k}`) : ['None observed.']), '');
  lines.push('## Limitations', '', ...r.limitations.map((l) => `- ${l}`), '');
  lines.push('## Isolation', '', `- Mode: **${r.isolation.mode}** (operating-system user separation: ${r.isolation.uid_separation ? `yes, uid ${r.isolation.candidate_uid}` : 'no'}; Node permission model: ${r.isolation.node_permission_model ? 'yes' : 'no'})`, `- Protected store intact before and after: ${r.isolation.intact ? 'yes' : 'NO'}`, ...r.isolation.notes.map((n) => `- ${n}`), '');
  lines.push('## Release', '');
  if (r.release_manifest) lines.push(renderManifest(r.release_manifest), '', `Rollback target: ${r.rollback_target}.`);
  else lines.push('No release was created. The candidate and this result are kept.');
  lines.push('', `Receipt hash: \`${r.receipt_hash}\``, '');
  return lines.join('\n');
}

export function renderManifest(m: ReleaseManifest): string {
  return [
    `Release **${m.release_id}** (${m.status}; evidence basis: ${m.evidence_basis}; parent ${m.parent_release_id ?? 'none'})`,
    '',
    '| Level | Version | Content hash |',
    '|---|---|---|',
    ...(['execution', 'coordination', 'evolution'] as const).map((l) => `| ${l} | v${m.components[l].version} | \`${m.components[l].content_hash.slice(0, 16)}\` |`),
    '',
    `Policy hash \`${m.policy_hash.slice(0, 16)}\`; evaluation snapshot ${m.evaluation_snapshot_hash ? `\`${m.evaluation_snapshot_hash.slice(0, 16)}\`` : '—'}; receipt ${m.receipt_id ?? '—'}; manifest hash \`${m.manifest_hash.slice(0, 16)}\`.`,
  ].join('\n');
}
