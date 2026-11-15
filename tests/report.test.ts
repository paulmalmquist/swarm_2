import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEV_PROFILE, REPO_ROOT, devBudget } from '../src/config.ts';

/**
 * The documents quote figures; the figures live in `evidence/`. Each claim below builds a
 * sentence fragment and requires a document to contain exactly that. Most claims rebuild a figure
 * from an evidence file. Some are a fixed sentence guarded by assertions on the evidence: the
 * sentence is only accepted while what it says is true of the files.
 *
 * A figure that legitimately differs from run to run (a timing, the regression a canary measures
 * on freshly drawn cases) is quoted in the documents as approximate and checked here as a band, so
 * that intentionally regenerating historical bundles detects material drift. `npm run verify`
 * and CI write fresh fixture runs separately under evidence/validation/ instead.
 *
 * What this cannot do: say whether a sentence is a fair reading of its figure, or check a
 * sentence nobody wrote a claim for. The second test plants wrong figures and requires them to be
 * caught, which keeps the claims from passing whatever the documents say.
 */
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const cache = new Map<string, Json>();
const json = (p: string): Json => {
  if (!cache.has(p)) cache.set(p, JSON.parse(readFileSync(join(REPO_ROOT, p), 'utf8')));
  return cache.get(p);
};
const text = (p: string): string => readFileSync(join(REPO_ROOT, p), 'utf8');
const flat = (s: string): string => s.replace(/\s+/g, ' ');

const DOCS = { report: 'docs/evidence-report.md', handoff: 'docs/handoff.md', guide: 'docs/operator-guide.md', readme: 'README.md', progress: 'PROGRESS.md' } as const;
type Doc = keyof typeof DOCS;
interface Claim {
  doc: Doc;
  from: string;
  says: () => string;
}
const claims: Claim[] = [];
const claim = (doc: Doc, from: string, says: () => string): void => void claims.push({ doc, from, says });
/** For a figure that varies between runs: the evidence must fall inside the band the document implies. */
const within = (value: number, lo: number, hi: number, what: string): void => assert.ok(value >= lo && value <= hi, `${what} is ${value}, outside ${lo} to ${hi}: the document's approximate figure no longer describes it`);

const f = (n: number, digits: number): string => n.toFixed(digits);
const secs = (ms: number): string => String(Math.round(ms / 1000));
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const word = (n: number): string => WORDS[n] ?? String(n);
const cap = (s: string): string => s[0]!.toUpperCase() + s.slice(1);
/** The observed text of one check in a demonstration bundle, found by a phrase in its claim (or the whole claim). */
const observed = (demo: string, claimPhrase: string): string => {
  const steps = json(`evidence/demo-${demo}/summary.json`).steps as { claim: string; observed: string; ok: boolean }[];
  const exact = steps.filter((s) => s.claim === claimPhrase);
  const hit = exact.length ? exact : steps.filter((s) => s.claim.includes(claimPhrase));
  assert.equal(hit.length, 1, `demo ${demo}: exactly one check mentions "${claimPhrase}"`);
  return hit[0]!.observed;
};
/** A number captured from an observed line. */
const num = (s: string, re: RegExp): number => {
  const m = re.exec(s);
  assert.ok(m, `"${s.slice(0, 120)}" matches ${re}`);
  return Number(m[1]);
};

// ───────── live missions (docs/evidence-report.md §2.1) ─────────

const LIVE = ['live-a', 'live-b', 'live-c'];
const live = (x: string): Json => json(`evidence/${x}/summary.json`);
const timeline = (x: string): { seq: number; ts: string; type: string; payload: Json }[] => json(`evidence/${x}/timeline.json`);
const OUTCOME: Record<string, string> = { blocked: 'Blocked', review_ready: 'Reached review' };
for (const x of LIVE) {
  claim('report', `evidence/${x}/summary.json`, () => {
    const s = live(x);
    const timeouts = s.attempts.filter((a: Json) => a.error === 'timeout').length;
    const passed = s.acceptance.filter((a: Json) => a.verdict === 'pass').length;
    return `| \`${x}\` | **${OUTCOME[s.mission.status]}** | ${secs(s.elapsed_ms)} s | ${s.execution.model_attempts}${timeouts ? ` (${timeouts} timed out)` : ''} | ${s.rework.length} | ${s.integration_failures} | ${passed} of ${s.acceptance.length} passed`;
  });
  claim('report', `evidence/${x}/summary.json`, () => {
    const s = live(x);
    const unreported = s.attempts.filter((a: Json) => a.provider !== 'fixture' && a.cost_usd_list_price_estimate === null).length;
    return `| ${unreported ? 'at least ' : ''}${f(s.execution.cost_usd_list_price_estimate, 2)} USD | ${s.waiting_for_a_person}: `;
  });
}
claim('report', 'evidence/live-a/summary.json', () => {
  const acc = live('live-a').acceptance;
  const failed = acc.filter((a: Json) => a.verdict === 'fail');
  const repaired = acc.filter((a: Json) => a.verdict === 'pass' && a.verdict_history.includes('fail'));
  assert.equal(failed.length, 1);
  assert.ok(failed[0].verdict_history.every((v: string) => v === 'fail'));
  return `passed, ${word(repaired.length)} of them after a repair; one failed ${word(failed[0].verdict_history.length)} times`;
});
claim('report', 'evidence/live-a/summary.json', () => {
  const repaired = live('live-a').acceptance.find((a: Json) => a.verdict === 'pass' && a.verdict_history.includes('fail'));
  assert.deepEqual(repaired.verdict_history, ['fail', 'pass', 'pass']);
  assert.match(live('live-a').rework[0].why, /AC-SCHEMA-SUPPLY .*supplier_id.*alert\.detail/);
  return `\`live-a\` also failed ${repaired.criterion} in its first round, for an alert that did not name the drifted field`;
});
claim('report', 'evidence/live-b/summary.json', () => {
  const h = live('live-b').acceptance.find((a: Json) => a.verdict_history.includes('fail')).verdict_history;
  return `4 of 4 passed after ${word(h.filter((v: string) => v === 'fail').length)} repairs`;
});
claim('report', 'evidence/live-c/summary.json', () => {
  const h = live('live-c').acceptance.find((a: Json) => a.verdict_history.includes('fail')).verdict_history;
  return `4 of 4 passed after ${word(h.filter((v: string) => v === 'fail').length)} repair |`;
});
claim('report', 'evidence/live-*/summary.json', () => {
  const models = new Set(LIVE.flatMap((x) => live(x).execution.models_served));
  return `Models served were recorded per attempt: ${[...models].sort().map((m) => `\`${m}\``).join(' and ')}.`;
});
claim('report', 'evidence/live-b/timeline.json', () => {
  const s = live('live-b');
  const stopped = s.attempts.filter((a: Json) => a.error === 'timeout');
  const done = s.attempts.filter((a: Json) => a.provider !== 'fixture' && a.error === null);
  // How long each stopped attempt ran: from its lease to its failure, in the event log.
  const ev = timeline('live-b');
  const ran = ev.filter((e) => e.type === 'attempt_failed' && e.payload.error?.code === 'timeout').map((fail) => {
    const lease = ev.filter((e) => e.type === 'task_leased' && e.payload.token === fail.payload.token && e.payload.key === fail.payload.key).pop()!;
    return (Date.parse(fail.ts) - Date.parse(lease.ts)) / 1000;
  });
  assert.equal(ran.length, stopped.length);
  const rounded = new Set(ran.map((r) => Math.round(r)));
  assert.equal(rounded.size, 1, `each stopped attempt ran about the same time: ${ran.join(', ')}`);
  return `covers the ${word(done.length)} attempts that completed, and the ${word(stopped.length)} that were stopped at their deadline, after about ${[...rounded][0]} s each, never reported what they used`;
});
claim('report', 'evidence/live-*/summary.json', () => {
  const all = LIVE.map(live);
  assert.ok(all.every((s) => s.integration_failures === 0), 'no integration failure in any live run');
  // A workstream that failed its own unit tests would have been sent back for that reason. None was.
  assert.ok(all.every((s) => s.rework.every((r: Json) => r.why.startsWith('independent acceptance failed'))), 'all rework followed an acceptance failure');
  assert.ok(all.every((s) => s.acceptance.some((a: Json) => a.verdict_history[0] === 'fail')), 'the first integrated result failed a hidden criterion in every run');
  return 'In all three runs the two independently written';
});
claim('report', 'evidence/live-*/summary.json', () => {
  const n = LIVE.reduce((a, x) => a + live(x).harness_denials.reduce((b: number, d: Json) => b + d.count, 0), 0);
  return `${cap(word(n))} tool uses were refused across the runs`;
});
claim('report', 'evidence/live-b/summary.json', () => {
  const s = live('live-b').budget.spent;
  return `Its \`budget.spent\` block reads ${f(s.cost_usd_est, 2)} USD, ${s.tokens.toLocaleString('en-US')} tokens and ${s.model_calls} model calls.`;
});
const reserveMoves = (): Json[] => timeline('live-b').filter((e) => e.type === 'recovery_reserve_used').map((e) => e.payload.amount);
const moved = (k: string): number => reserveMoves().reduce((a: number, m: Json) => a + m[k], 0);
claim('report', 'evidence/live-b/timeline.json', () => {
  // What the recovery reserve handed over, from the event log, and that it accounts for the gap
  // between what the bundle says was spent and what the attempts reported.
  const s = live('live-b');
  const reported = s.attempts.reduce((a: number, t: Json) => a + (t.cost_usd_list_price_estimate ?? 0), 0);
  assert.ok(Math.abs(s.budget.spent.cost_usd_est - reported - moved('cost_usd_est')) < 1e-6, 'the transfers are exactly the unexplained spend');
  return `Of that, ${f(moved('cost_usd_est'), 2)} USD, ${moved('tokens').toLocaleString('en-US')} tokens and ${moved('model_calls')} calls are ${word(reserveMoves().length)} transfers`;
});
claim('report', 'evidence/live-b/timeline.json', () => `spend included ${f(moved('cost_usd_est'), 2)} USD and ${moved('tokens').toLocaleString('en-US')} tokens that nobody used`);
claim('report', 'evidence/live-b/summary.json', () => `\`live-b\`'s bundle counts ${word(live('live-b').acceptance_failures)} acceptance failures`);
claim('report', 'evidence/live-b/summary.json', () => {
  assert.match(live('live-b').decisions[0].question, /Last rejection: not recorded/);
  assert.ok(live('live-b').attempts.filter((a: Json) => a.task === 'reliability.knowledge').every((a: Json) => a.error === 'timeout'));
  return `its question reads "Last rejection: not recorded". The failure was a timeout, not a rejection`;
});
claim('report', 'evidence/live-a/timeline.json', () => {
  const ev = timeline('live-a');
  const blockedAt = ev.find((e) => e.type === 'mission_status_changed' && e.payload.to === 'blocked')!.seq;
  const late = ev.filter((e) => e.type === 'attempt_failed' && e.seq > blockedAt);
  assert.equal(late.length, 1);
  assert.equal(late[0]!.payload.key, 'delivery.integrate');
  assert.equal(late[0]!.payload.error.code, 'integration_input_missing');
  assert.ok(ev.some((e) => e.type === 'task_requeued' && e.seq > late[0]!.seq));
  assert.deepEqual(ev.find((e) => e.type === 'decision_opened')!.payload.options, ['cancel', 'hold']);
  return 'After the mission was blocked, the integration step ran once more, failed because one workstream was no longer accepted, and was queued again';
});
claim('report', 'evidence/live-c/timeline.json', () => {
  const over = timeline('live-c').filter((e) => e.type === 'budget_overrun');
  assert.equal(over.length, 1);
  assert.equal(over[0]!.payload.key, 'reliability.knowledge');
  const m = /wall_ms: need (\d+), available (\d+)/.exec(over[0]!.payload.shortfall)!;
  assert.equal(Number(m[2]), reserveMoves()[0].wall_ms, 'the same allowance as in live-b');
  return `In \`live-c\` knowledge capture took ${f(Number(m[1]) / 1000, 1)} s against a time allowance of ${f(Number(m[2]) / 1000, 1)} s`;
});
claim('report', 'evidence/live-c/artifacts/review__packet.md', () => {
  const packet = text('evidence/live-c/artifacts/review__packet.md');
  assert.match(packet, /4 of 4 acceptance criteria passed independent verification\./);
  assert.ok(packet.indexOf('4 of 4 acceptance criteria passed') < packet.indexOf('no criterion (deferred)'), 'the uncovered request appears further down');
  return `\`live-c\`'s review packet opens with "4 of 4 acceptance criteria passed"`;
});
claim('report', 'evidence/live-b/worker-reports/delivery.report.implement.json', () => {
  const said = json('evidence/live-b/worker-reports/delivery.report.implement.json').summary as string;
  const quote = `this change is a guess at what the failed acceptance check wanted, so I'm not claiming AC-SLA-QUALITY is met`;
  assert.ok(said.includes(quote));
  return `"${quote}"`;
});
claim('report', 'evidence/live-*/worker-reports/', () => {
  for (const x of LIVE) {
    for (const file of readdirSync(join(REPO_ROOT, 'evidence', x, 'worker-reports'))) {
      const claimed = (json(`evidence/${x}/worker-reports/${file}`).criteria_claims ?? []) as { criterion_id: string }[];
      assert.ok(claimed.every((c) => !c.criterion_id.startsWith('AC-')), `${x}/${file} claims no hidden acceptance criterion`);
    }
  }
  return `They claimed only their own task's criteria, never the hidden acceptance criteria.`;
});
claim('report', 'evidence/live-a/worker-reports/delivery.report.implement.json', () => {
  assert.match(json('evidence/live-a/worker-reports/delivery.report.implement.json').summary, /I read the earlier rejection as objecting to the dash/);
  return 'read that as the complaint, and removed the dash';
});
claim('report', 'evidence/live-*/summary.json', () => {
  // Discovery left the schema-drift request out in live-b and live-c; only live-c asked a person.
  const scope = (x: string): number => live(x).decisions.filter((d: Json) => d.kind === 'scope_change').length;
  const criteria = (x: string): string[] => live(x).acceptance.map((a: Json) => a.criterion);
  assert.ok(criteria('live-a').includes('AC-SCHEMA-SUPPLY'));
  assert.ok(!criteria('live-b').includes('AC-SCHEMA-SUPPLY') && !criteria('live-c').includes('AC-SCHEMA-SUPPLY'));
  assert.deepEqual([scope('live-a'), scope('live-b'), scope('live-c')], [0, 0, 1]);
  return 'Discovery narrowed the scope twice; the second time it reached a person.';
});
claim('report', 'evidence/live-*/summary.json', () => {
  // Knowledge capture: never dispatched in live-a, timed out in live-b, completed in live-c.
  const knowledge = (x: string): string[] => live(x).attempts.filter((a: Json) => a.task === 'reliability.knowledge').map((a: Json) => a.status);
  assert.deepEqual(knowledge('live-a'), []);
  assert.ok(knowledge('live-b').length > 0 && knowledge('live-b').every((s) => s === 'failed'));
  assert.deepEqual(knowledge('live-c'), ['succeeded']);
  return 'knowledge capture (haiku; it ran to completion only in `live-c`)';
});
claim('report', 'evidence/live-*/summary.json', () => {
  assert.ok(LIVE.every((x) => live(x).decisions.every((d: Json) => d.status === 'open')), 'every decision in every live bundle is still open');
  return `No decision was made on Paul's behalf in any live run.`;
});
claim('report', 'evidence/live-c/summary.json', () => {
  const s = live('live-c');
  return `\`live-c\`: ${s.budget.spent.worker_invocations} worker invocations, ${s.budget.spent.model_calls} model calls, ${f(s.execution.tokens_out / 1000, 1)}k output tokens, ${f(s.execution.cost_usd_list_price_estimate, 2)} USD estimate`;
});
claim('report', 'evidence/live-*/summary.json', () => {
  const rounds = LIVE.map((x) => Math.max(...live(x).acceptance.map((a: Json) => a.verdict_history.filter((v: string) => v === 'fail').length)));
  return `${rounds[0]}, ${rounds[1]} and ${rounds[2]} failed acceptance rounds`;
});
claim('report', 'evidence/live-*/summary.json', () => {
  const all = LIVE.map(live);
  return `${all.reduce((a, s) => a + s.integration_failures, 0)} integration failures; ${all[0].rework.length}, ${all[1].rework.length} and ${all[2].rework.length} reworks`;
});
claim('report', 'evidence/live-*/timeline.json', () => {
  const all = LIVE.map(live);
  const corrections = LIVE.reduce((a, x) => a + timeline(x).filter((e) => /correction|task_revived|decision_resolved/.test(e.type)).length, 0);
  return `${corrections} corrections; ${all[0].waiting_for_a_person}, ${all[1].waiting_for_a_person} and ${all[2].waiting_for_a_person} decisions waiting`;
});
claim('report', 'evidence/live-*/summary.json', () => {
  const t = LIVE.map((x) => Number(secs(live(x).elapsed_ms)));
  return `| ${Math.min(...t)} to ${Math.max(...t)} s |`;
});
claim('report', 'evidence/live-*/summary.json', () => {
  const reached = LIVE.filter((x) => live(x).reached_review).length;
  return `${reached} reached review; ${LIVE.length - reached} stopped for a person`;
});

// ───────── a model as improvement author (§2.2) ─────────

const author1 = (): Json => json('evidence/live-improve/summary.json');
const author2 = (): Json => json('evidence/live-improve-2/summary.json');
const cmp = (gate: Json, metric: string): Json => gate.comparisons.find((c: Json) => c.metric === metric);
const improveRow = (label: string, round: string, a: Json, gate: Json, extra: string): string => {
  const acc = cmp(gate, 'accuracy');
  const esc = cmp(gate, 'escaped_defect_rate');
  const fa = cmp(gate, 'false_alarm_rate');
  return `| \`${label}\` | ${round} | ${f(a.report.development_accuracy, 2)} | ${gate.holdout_set} | ${acc.incumbent === 0.5 ? '0.50' : String(acc.incumbent)} → ${acc.candidate === 1 ? '1.00' : String(acc.candidate)}${extra} | ${f(esc.incumbent, 2)} → ${String(esc.candidate)} | ${String(fa.incumbent)} → ${fa.candidate === 0 ? '0' : `**${f(fa.candidate, 2)}**`} | **${cap(gate.decision)}**`;
};
claim('report', 'evidence/live-improve/summary.json', () => improveRow('live-improve', '1', author1().author, author1().gate, ''));
claim('report', 'evidence/live-improve-2/summary.json', () => improveRow('live-improve-2', '1', author2().rounds[0].author, author2().rounds[0].gate, ''));
claim('report', 'evidence/live-improve-2/summary.json', () => {
  const g = author2().rounds[1].gate;
  const a = cmp(g, 'accuracy');
  return improveRow('live-improve-2', '2 (revision)', author2().rounds[1].author, g, ` (difference ${a.difference}, 95% interval ${f(a.ci95[0], 2)} to ${a.ci95[1]}, n=${a.n})`);
});
claim('report', 'evidence/live-improve/summary.json', () => {
  const o = author1().observed;
  const failures = Object.values(o.failures_by_class as Record<string, number>).reduce((a, b) => a + b, 0);
  assert.deepEqual(author2().observed, o, 'both runs started from the same observations');
  return `observed ${failures} verified failures in ${o.reviewed} development reviews by its change-review skill (accuracy ${Math.round(o.accuracy * 100)}%)`;
});
const authorRounds = (): Json[] => [author1().author, ...author2().rounds.map((r: Json) => r.author)];
claim('report', 'evidence/live-improve*/summary.json', () => {
  assert.ok(authorRounds().every((r: Json) => r.models_served.join() === 'claude-opus-5-5'));
  const s = authorRounds().map((r: Json) => Math.round(r.wall_ms / 1000));
  const c = authorRounds().map((r: Json) => r.cost_usd_list_price_estimate as number);
  return `Author effort: ${Math.min(...s)} to ${Math.max(...s)} seconds and ${f(Math.min(...c), 2)} to ${f(Math.max(...c), 2)} USD (list-price estimate) per round.`;
});
claim('report', 'evidence/live-improve*/summary.json', () => {
  const denials = authorRounds().flatMap((r: Json) => r.denials);
  assert.ok(denials.every((d: Json) => d.tool === 'Bash' && d.target.includes('node -e')), 'each refused use was an ad hoc node -e script');
  return `The harness refused ${word(denials.length)} tool uses by the author across the runs`;
});
claim('report', 'evidence/live-improve*/summary.json', () => {
  const accepted = [author1().gate, ...author2().rounds.map((r: Json) => r.gate)].filter((g: Json) => g.decision === 'accept').length;
  const cost = authorRounds().reduce((a: number, r: Json) => a + r.cost_usd_list_price_estimate, 0);
  return `${accepted} accepted of ${authorRounds().length} model-written candidates, for about ${f(cost, 1)} USD of author time`;
});
claim('report', 'evidence/live-improve*/receipt.json', () => {
  // What the rejected candidates got wrong, from the receipts' own list of regressions.
  const first = json('evidence/live-improve/receipt.json').known_regressions as string[];
  assert.deepEqual(json('evidence/live-improve-2/round-1/receipt.json').known_regressions, first);
  const m = /^nullability_added: (\d+)\/(\d+) correct, down from \2\/\2 under the incumbent$/.exec(first.find((r) => r.startsWith('nullability_added'))!)!;
  assert.ok(!text('fixtures/evolution/review-cases.ts').includes('nullability_added'), 'the development cases do not contain this kind');
  const j = author1().gate.justification as string;
  const share = /candidate ([\d.]+)%, incumbent 0\.0%; allowed margin ([\d.]+)%/.exec(j)!;
  assert.equal(author2().rounds[0].gate.justification, j);
  return `they blocked ${Number(m[2]) - Number(m[1])} of the ${m[2]} changes that only make a field nullable, a safe kind of change that the development cases do not contain (the receipts' \`known_regressions\`). That is ${Number(share[1])}% of safe changes; the allowed increase is ${Number(share[2])}%.`;
});
claim('report', 'evidence/live-improve-2/round-2/authored/TASK.md', () => {
  const task = text('evidence/live-improve-2/round-2/authored/TASK.md');
  assert.match(task, /you will not be told which ones went wrong/);
  assert.match(task, /accuracy 0\.5 for the current skill and 0\.9625 with your check; share of breaking changes approved 0\.8 and 0; share of safe changes blocked 0 and 0\.1/);
  assert.match(task, /The development cases in dev-cases\.json do not contain every kind of change\./);
  assert.match(task, /treats as breaking although a consumer of the contract would not be broken by them/);
  return `The revision was written from the gate's decision and three rates, plus fixed guidance that the development cases do not contain every kind of change and that it should look for safe changes it treats as breaking. It was not told which cases failed.`;
});
claim('report', 'evidence/live-improve-2/round-2/receipt.json', () => {
  const r = json('evidence/live-improve-2/round-2/receipt.json');
  const steps = r.comparisons.find((c: Json) => c.metric === 'steps_per_review');
  const cost = r.gates.find((g: Json) => g.id === 'cost');
  assert.equal(cost.kind, 'WEIGHTED');
  assert.equal(cost.verdict, 'FAILED');
  assert.equal(r.decision, 'accept');
  assert.equal(steps.candidate - steps.incumbent, 1);
  return `The accepted check adds one step to every review (${steps.incumbent} to ${steps.candidate}). The gate's weighted cost criterion recorded that as failed`;
});
const canaryObs = (): Json[] => author2().canary.observations;
claim('report', 'evidence/live-improve-2/summary.json', () => {
  assert.equal(new Set(canaryObs().map((o) => o.at)).size, 1, 'one observation');
  assert.equal(author2().canary.status, 'retained');
  assert.match(text('evidence/live-improve-2/README.md'), /Canary on fresh cases: \*\*retained\*\*\. Active release afterwards: r2\./);
  assert.equal(canaryObs().find((o) => o.value === null).metric, 'canary_missions_with_acceptance_failures');
  return `The canary was one observation on ${json('protected/policy.json').canary.fresh_cases} fresh cases, not a period of use, and it measured ${word(canaryObs().filter((o) => o.value !== null).length)} of its ${word(canaryObs().length)} metrics`;
});
claim('report', 'evidence/live-improve-2/summary.json', () => `None in one canary observation, which measured ${word(canaryObs().filter((o) => o.value !== null).length)} of ${word(canaryObs().length)} metrics`);
claim('report', 'evidence/live-improve-2/release-manifest.md', () => {
  assert.match(text('evidence/live-improve-2/release-manifest.md'), /evidence basis: fixture/);
  for (const p of ['evidence/live-improve/receipt.json', 'evidence/live-improve-2/round-1/receipt.json', 'evidence/live-improve-2/round-2/receipt.json']) assert.equal(json(p).evidence_basis, 'fixture');
  return 'the receipts and the release manifest record it as such ("evidence basis: fixture")';
});
claim('report', 'evidence/demo-c + evidence/live-improve-2', () => {
  // The same figures in two places, because both candidates were perfect on the same fixed set.
  const model = cmp(author2().rounds[1].gate, 'accuracy');
  const scripted = /accuracy ([\d.]+) → ([\d.]+) \(difference ([\d.]+), 95% interval ([\d.]+) to ([\d.]+), n=(\d+)\)/.exec(observed('c', 'fixed original baseline'))!;
  assert.deepEqual([model.incumbent, model.candidate, model.difference, model.ci95[0], model.ci95[1], model.n], scripted.slice(1).map(Number));
  assert.equal(author2().rounds[1].gate.holdout_set, 'holdout-B');
  assert.match(observed('c', 'never scored on cases its lineage'), /revision on holdout-B/);
  return `Its figures are identical to demonstration C's accepted revision because both were perfect on the same fixed set, \`holdout-B\``;
});
claim('handoff', 'evidence/live-improve-2/summary.json', () => {
  const a = cmp(author2().rounds[1].gate, 'accuracy');
  return `(accuracy ${f(a.incumbent, 2)} → ${f(a.candidate, 2)})`;
});
claim('handoff', 'evidence/live-improve/summary.json', () => {
  const share = /candidate ([\d.]+)%/.exec(author1().gate.justification)!;
  return `it blocked ${Number(share[1])}% of safe changes on held-out cases`;
});

// ───────── demonstrations on fixtures (§3) ─────────

const index = (): Json => json('evidence/summary.json');
const demo = (d: string): Json => index().results.find((r: Json) => r.demo === d);
for (const [d, title] of [['a', 'A. Cross-swarm delivery'], ['b', 'B. Failure recovery'], ['e', 'E. Rejection'], ['f', 'F. Isolation'], ['g', 'G. Canary and rollback']] as const) {
  claim('report', 'evidence/summary.json', () => {
    const r = demo(d);
    assert.equal(r.held, r.checks, `every check of demonstration ${d} held`);
    return `**${title} — ${r.held} of ${r.checks}${d === 'a' ? ' checks' : ''}.**`;
  });
}
claim('report', 'evidence/summary.json + demos/', () => {
  const results = index().results as Json[];
  assert.ok(results.every((r) => r.ok && r.held === r.checks), 'every check of every demonstration held');
  // A demonstration whose bundle is labeled as a simulation or as resting on assumed rates is a testbed.
  const testbed = results.filter((r) => (r.labels as string[]).some((l) => /^SIMULATION|^ASSUMED RATES/.test(l))).length;
  const drivers = readdirSync(join(REPO_ROOT, 'demos')).filter((x) => /^live.*\.ts$/.test(x)).length;
  return `${cap(word(results.length))} demonstrations (${word(results.length - testbed)} on fixtures, ${word(testbed)} in testbeds with assumed rates), ${word(drivers)} live drivers`;
});
claim('report', 'evidence/*/', () => {
  const bundles = readdirSync(join(REPO_ROOT, 'evidence')).filter((b) => existsSync(join(REPO_ROOT, 'evidence', b, 'README.md')));
  const has = (b: string, re: RegExp): boolean => (readdirSync(join(REPO_ROOT, 'evidence', b), { recursive: true }) as string[]).some((p) => re.test(p));
  const receipts = bundles.filter((b) => has(b, /receipt.*\.json$/)).sort();
  const manifests = bundles.filter((b) => has(b, /release-manifest/)).sort();
  assert.deepEqual(receipts, ['demo-c', 'demo-d', 'demo-e', 'demo-f', 'demo-g', 'demo-h', 'demo-i', 'live-improve', 'live-improve-2']);
  return `Receipts: \`evidence/demo-c\` to \`-i\`, \`live-improve*\`. Manifests: ${manifests.map((m, i) => `\`${i > 0 && m.startsWith('demo-') ? m.slice(4) : m}\``).join(', ')}`;
});
claim('report', 'evidence/demo-a/summary.json', () => {
  const o = observed('a', 'separate processes');
  return `two workstreams concurrent in separate worktrees, ${num(o, /^(\d+) worker attempts in \1 distinct processes/)} worker processes`;
});
claim('report', 'evidence/demo-a/summary.json', () => {
  const m = /(\d+)\/(\d+) tasks accepted/.exec(observed('a', 'reviewable state'))!;
  return `${m[1]} of ${m[2]} tasks accepted; ${num(observed('a', 'Resource accounting'), /^(\d+) accounts reconcile/)} budget accounts reconcile;`;
});
claim('report', 'evidence/demo-a/summary.json', () => `${num(observed('a', 'hash-chained event log'), /^(\d+) events, chain intact/)} events, chain intact`);
claim('report', 'evidence/demo-a/summary.json', () => {
  const o = observed('a', 'three swarm capabilities');
  return `${word(num(o, /^(\d+) participated/))} swarm capabilities took part (${o.split(': ')[1]})`;
});
claim('report', 'evidence/demo-a/summary.json', () => `A: ${num(observed('a', 'Resource accounting'), /(\d+) worker invocations/)} invocations, 0 model calls`);
claim('report', 'evidence/summary.json', () => {
  within(demo('a').ms, 2000, 4500, 'the run time of demonstration A in ms');
  return 'A: about 3 s (scripted durations)';
});
claim('report', 'evidence/demo-b/summary.json', () => {
  const o = observed('b', 'duplicate delivery');
  return `${word(num(o, /^(\d+) redelivered requests ignored/))} redelivered requests were ignored`;
});
claim('report', 'evidence/demo-b/summary.json', () => {
  const marked = Object.fromEntries(observed('b', 'invalidates exactly').split('; ').map((x) => x.split(': ') as [string, string]));
  assert.deepEqual(Object.keys(marked).filter((k) => marked[k] === 'rerun_required').sort(), ['delivery.engine.implement', 'delivery.report.implement', 'reliability.knowledge']);
  assert.deepEqual(Object.keys(marked).filter((k) => marked[k] === 'downstream_blocked').sort(), ['delivery.integrate', 'review.packet']);
  assert.match(observed('b', 'Only affected work is redone'), /^discovery, criteria, plan and decomposition were not rerun; engine and report were rebuilt/);
  return 'engine and report were rebuilt, and the integration, knowledge and packet steps that depend on them were redone';
});
claim('report', 'evidence/demo-e/summary.json', () => {
  const steps = /steps per review (\d+) → (\d+)/.exec(observed('e', 'really is cheaper'))!;
  const esc = /share of breaking changes approved ([\d.]+) → ([\d.]+)/.exec(observed('e', 'measured consequence'))!;
  return `A candidate cut review steps from ${steps[1]} to ${steps[2]} by omitting a required verification step. The gate rejected it on a hard gate. On held-out cases the share of breaking changes approved rose from ${f(Number(esc[1]), 2)} to ${f(Number(esc[2]), 2)}.`;
});
claim('report', 'evidence/demo-f/summary.json', () => {
  const forced = observed('f', 'Run anyway').split('; ');
  assert.ok(forced.every((x) => /: denied \(/.test(x)));
  const os = observed('f', 'operating system alone').split('; ');
  assert.ok(os.every((x) => /: denied \(EACCES\)/.test(x)));
  assert.match(observed('f', 'actual separation'), /mode enforced: candidate code runs as uid 65534; the protected store is owned by uid 0 with mode 0700/);
  return `all ${word(forced.length)} attempts (overwrite the policy, overwrite the scoring rules, read the held-out cases, append to the ledger, rewrite the release pointer, plant a result) were denied. With Node's permission model removed, the operating system alone denied all ${word(os.length)} attempts made.`;
});
claim('report', 'evidence/demo-g/canary.json', () => {
  const o = json('evidence/demo-g/canary.json').observations.find((x: Json) => x.breached);
  assert.ok(o.injected && o.metric === 'accuracy_drop_vs_approval');
  // The size varies with the cases a canary draws. What the sentence needs is "well above".
  within(o.value, 2 * o.threshold, 1, 'the injected accuracy drop');
  return `An injected regression produced an accuracy drop well above the limit of ${o.threshold}`;
});
claim('report', 'evidence/demo-g/summary.json', () => {
  const m = /^(\d+) missions .*?, (\d+) artifacts, (\d+) memories/.exec(observed('g', 'are identified'))!;
  return `${m[1]} missions, ${m[2]} artifacts and ${m[3]} memories that depended on the withdrawn release were identified and marked`;
});

// ───────── improvement and coordination experiments (§4) ─────────

claim('report', 'evidence/demo-c/summary.json', () => {
  const first = /accuracy ([\d.]+) → ([\d.]+), but Share of safe changes blocked: candidate ([\d.]+)%/.exec(observed('c', 'helps but harms'))!;
  return `A first candidate raised held-out accuracy from ${f(Number(first[1]), 2)} to ${f(Number(first[2]), 2)} but blocked ${Number(first[3])}% of safe changes and was rejected.`;
});
claim('report', 'evidence/demo-c/summary.json', () => {
  const m = /accuracy ([\d.]+) → ([\d.]+) \(difference ([\d.]+), 95% interval ([\d.]+) to ([\d.]+), n=(\d+)\)/.exec(observed('c', 'fixed original baseline'))!;
  return `went from ${m[1]} to ${f(Number(m[2]), 2)} (difference ${m[3]}, 95% interval ${f(Number(m[4]), 2)} to ${m[5]}, n=${m[6]}), was accepted, survived a canary and was retained.`;
});
const dBenefit = (): RegExpExecArray => /validated benefit ([\d.]+) → ([\d.]+) per 100 reviews \(difference ([\d.]+), 95% interval ([\d.-]+) to ([\d.-]+)\); sign test: (\d+) better, (\d+) worse, (\d+) same, p=([\d.]+)/.exec(observed('d', 'independently validated improvement'))!;
const dBudget = (): RegExpExecArray => /(\d+) episodes from held-out set arena-A; budget (\d+) units each; mean spent ([\d.]+) \(incumbent\) and ([\d.]+) \(candidate\)/.exec(observed('d', 'equal budgets'))!;
claim('report', 'evidence/demo-d/summary.json', () => {
  const m = dBenefit();
  return `| Independently validated benefit per 100 reviews | ${f(Number(m[1]), 1)} | ${f(Number(m[2]), 1)} | +${f(Number(m[3]), 1)} (${f(Number(m[4]), 2)} to ${f(Number(m[5]), 1)}); sign test ${m[6]} better, ${m[7]} worse, ${m[8]} same, p=${f(Number(m[9]), 3)} |`;
});
claim('report', 'evidence/demo-d/summary.json', () => {
  const m = /fixes that failed: ([\d.]+) → ([\d.]+) units per campaign \(difference (-[\d.]+), 95% interval (-[\d.]+) to (-[\d.]+)\)/.exec(observed('d', 'unsuccessful experiments'))!;
  const neg = (x: string): string => `−${f(Math.abs(Number(x)), 1)}`;
  return `| Budget spent on fixes that failed | ${f(Number(m[1]), 1)} | ${f(Number(m[2]), 1)} | ${neg(m[3]!)} (${neg(m[4]!)} to ${neg(m[5]!)}) |`;
});
claim('report', 'evidence/demo-d/summary.json', () => `| Budget spent | ${f(Number(dBudget()[3]), 1)} | ${f(Number(dBudget()[4]), 1)} | |`);
claim('report', 'evidence/demo-d/summary.json', () => `equal budgets of ${dBudget()[2]} units, the same ${dBudget()[1]} unseen failure episodes`);
claim('report', 'evidence/demo-d/summary.json', () => {
  const m = /difference ([\d.]+) \(95% interval (-?[\d.]+) to ([\d.]+)\)\. In (\d+) of (\d+) episodes/.exec(observed('d', 'sensitivity check'))!;
  const lo = Number(m[2]);
  return `the advantage is **not demonstrated** (+${f(Number(m[1]), 1)}, interval ${lo < 0 ? '−' : ''}${f(Math.abs(lo) + 1e-9, 1)} to ${f(Number(m[3]) + 1e-9, 1)}). In ${m[4]} of ${m[5]} episodes the new policy did worse.`;
});
claim('report', 'evidence/demo-d/summary.json', () => `The interval's lower bound is ${f(Number(dBenefit()[4]), 2)}.`);
claim('report', 'evidence/demo-d/summary.json', () => {
  const m = dBenefit();
  return `D: validated benefit of ${f(Number(m[2]), 1)} against ${f(Number(m[1]), 1)} per 100 reviews, on equal budgets of ${dBudget()[2]} units`;
});

claim('report', 'evidence/demo-i/README.md', () => {
  const m = /control: (\d+) on experiments not accepted plus (\d+) on builds never submitted; trial: (\d+) plus (\d+)\./.exec(text('evidence/demo-i/README.md'))!;
  return `| Units on experiments not accepted | ${m[1]} | ${m[3]} | | Units on builds never submitted | ${m[2]} | ${m[4]} |`;
});
claim('report', 'evidence/demo-i/summary.json', () => {
  const control = /used (\d+) of (\d+) units/.exec(observed('i', 'policy of the release in force decides'))!;
  const steps = [...text('evidence/demo-i/README.md').matchAll(/^Trial .*$/gm)][0]![0];
  const trial = [...steps.matchAll(/\((\d+) units\)/g)].reduce((a, m) => a + Number(m[1]), 0);
  return `| Units used | ${control[1]} | ${trial} |`;
});
claim('report', 'evidence/demo-i/summary.json', () => `a budget of ${/of (\d+) units/.exec(observed('i', 'policy of the release in force decides'))![1]} units`);
claim('report', 'evidence/demo-i/trial-guard_type_strict-rejected.receipt.json', () => {
  const j = json('evidence/demo-i/trial-guard_type_strict-rejected.receipt.json').justification as string;
  return `1 rejected: blocked ${/candidate ([\d.]+)%/.exec(j)![1]}% of safe changes`;
});
claim('report', 'evidence/demo-i/summary.json', () => {
  const m = /control: (\d+) accepted, \w+ \((\w+)\) not accepted; trial: (\d+) accepted, \w+ \((\w+)\) not accepted/.exec(observed('i', 'decided by the same release gate'))!;
  assert.deepEqual([m[2], m[4]], ['inconclusive', 'rejected']);
  return `| Accepted | ${m[1]} | ${m[3]} (the same fix) |`;
});

const hSelf = (): string => observed('h', 'really is cheaper and faster');
const hOracle = (): RegExpExecArray => /per mission (\d+) → ([\d.]+); truly correct missions (\d+) → ([\d.]+) \(difference (-[\d.]+), 95% interval (-[\d.]+) to (-[\d.]+)\)/.exec(observed('h', 'measured by an oracle'))!;
const hEpisodes = (): number => num(observed('h', 'same seeded missions'), /^(\d+) complete fixture missions per configuration/);
claim('report', 'evidence/demo-h/summary.json', () => {
  const m = /worker invocations per mission ([\d.]+) → ([\d.]+)/.exec(hSelf())!;
  return `Worker invocations per mission ${f(Number(m[1]) + 1e-9, 1)} → ${f(Number(m[2]), 1)};`;
});
claim('report', 'evidence/demo-h/summary.json', () => {
  const m = /completion (\d+) ms → (\d+) ms/.exec(hSelf())!;
  within(Number(m[1]), 3500, 4499, 'completion time with verification in ms');
  within(Number(m[2]), 2500, 3499, 'completion time without verification in ms');
  return 'completion about 4 s → 3 s';
});
claim('report', 'evidence/demo-h/summary.json', () => {
  const m = hOracle();
  const neg = (x: string): string => `−${Math.abs(Number(x))}`;
  return `Defects reaching an accepted result per mission ${m[1]} → ${m[2]}; truly correct missions ${f(Number(m[3]), 2)} → ${m[4]} (difference ${neg(m[5]!)}, interval ${neg(m[6]!)} to ${neg(m[7]!)}) | **Reject** |`;
});
claim('report', 'evidence/demo-h/summary.json', () => {
  const m = /integration failures per mission (\d+) → ([\d.]+); truly correct missions (\d+) → (\d+); invocations ([\d.]+) → ([\d.]+) \(difference ([\d.]+), 95% interval (-[\d.]+) to ([\d.]+)\)/.exec(observed('h', 'Integration failures and quality'))!;
  return `Invocations per mission ${m[5]} → ${f(Number(m[6]), 1)} (difference +${m[7]}, interval −${Math.abs(Number(m[8]))} to ${m[9]}); integration failures per mission ${m[1]} → ${m[2]} | Truly correct missions ${f(Number(m[3]), 2)} → ${f(Number(m[4]), 2)} |`;
});
claim('report', 'evidence/demo-h/summary.json', () => {
  assert.match(observed('h', 'cost of the step'), /^the agreement step costs 1 worker invocations .*; a mission where the workstreams disagreed cost 1 more invocations/);
  assert.match(observed('h', 'The decision follows the frozen rule, whatever it is'), /^inconclusive: /);
  return 'the step costs one worker invocation per mission, and a mission in which the workstreams disagreed cost one more invocation than the same mission with the agreement';
});
claim('report', 'evidence/demo-h/summary.json', () => {
  // Missions, not failing criteria: the share that was truly correct, times the number of missions.
  const m = hOracle();
  const n = hEpisodes();
  const withVerification = Math.round(n * (1 - Number(m[3])));
  const without = Math.round(n * (1 - Number(m[4])));
  return `H: ${withVerification === 0 ? 'no mission' : `${withVerification} missions`} with an escaped defect with verification, ${without} of ${n} without`;
});
claim('report', 'evidence/demo-h/summary.json', () => `H: ${Math.round(hEpisodes() * Number(hOracle()[3]))} of ${hEpisodes()} per incumbent arm`);
claim('report', 'evidence/demo-h/summary.json', () => {
  const m = /integration failures per mission (\d+) → ([\d.]+)/.exec(observed('h', 'Integration failures and quality'))!;
  return `H: ${m[2]} integration failures per mission without the agreement`;
});
claim('report', 'evidence/demo-h/summary.json', () => `${cap(word(hEpisodes()))} complete fixture missions per configuration`);

// ───────── tests, handoff, operator guide ─────────

const testCount = (): number =>
  readdirSync(join(REPO_ROOT, 'tests'))
    .filter((x) => x.endsWith('.test.ts'))
    .reduce((a, x) => a + (text(`tests/${x}`).match(/^test\(/gm) ?? []).length, 0);
// The count is the number of tests in the suite. That they pass is what running the suite shows.
claim('report', 'tests/*.test.ts', () => `| Tests for coordination, recovery, isolation, rollback | ${testCount()} tests, all passing |`);
claim('report', 'tests/*.test.ts', () => `**Tests.** ${testCount()} tests pass`);
claim('report', 'tests/*.test.ts', () => `npm test # ${testCount()} tests`);
claim('handoff', 'tests/*.test.ts', () => `${word(index().results.length)} demonstrations and ${testCount()} tests`);
claim('handoff', 'evidence/', () => `${word(LIVE.length)} missions and ${word(['live-improve', 'live-improve-2'].filter((x) => existsSync(join(REPO_ROOT, 'evidence', x))).length)} improvement runs with real models`);
claim('guide', 'tests/*.test.ts', () => `npm test # ${testCount()} tests`);
claim('readme', 'tests/*.test.ts', () => `npm test # ${testCount()} tests`);
claim('progress', 'tests/*.test.ts', () => `npm test # ${testCount()} tests`);
claim('guide', 'src/config.ts', () => `| Concurrent model calls | ${DEV_PROFILE.max_concurrent_model_calls} |`);
claim('guide', 'src/config.ts', () => `| Delegated layers | ${DEV_PROFILE.max_delegation_depth} |`);
claim('guide', 'src/config.ts', () => `| Worker invocations per mission | ${DEV_PROFILE.max_worker_invocations} (mission budget: ${devBudget().worker_invocations}) |`);
claim('guide', 'src/config.ts', () => `| Wall-clock per mission | ${DEV_PROFILE.max_wall_ms / 60_000} minutes of running time |`);
claim('guide', 'src/config.ts', () => `| Worker time per mission | ${devBudget().wall_ms / 60_000} minutes, summed over its workers (mission budget) |`);
claim('guide', 'src/config.ts', () => `per mission budget (${devBudget().tokens.toLocaleString('en-US')} tokens, ${devBudget().cost_usd_est} USD list-price estimate)`);
claim('guide', 'src/config.ts', () => `| Retries / repair attempts per task | ${DEV_PROFILE.max_retries_per_task} / ${DEV_PROFILE.max_repair_attempts} |`);
claim('guide', 'src/config.ts', () => `| Reserved for verification / recovery / completion | ${DEV_PROFILE.reserve.verification * 100}% / ${DEV_PROFILE.reserve.recovery * 100}% / ${DEV_PROFILE.reserve.completion * 100}% |`);
claim('guide', 'src/config.ts', () => `| Lease / heartbeat | ${DEV_PROFILE.lease_ms / 1000} s / ${DEV_PROFILE.heartbeat_ms / 1000} s |`);
claim('guide', 'src/config.ts', () => `| Minimum time for one live attempt | ${DEV_PROFILE.live_attempt_floor_ms / 60_000} minutes |`);
claim('guide', 'protected/policy.json', () => `| Experiment allocation | ${(json('protected/policy.json').exploration.budget_units as number).toLocaleString('en-US')} experiment units in total |`);

/** Each entry is a figure as a document states it, and the same figure made wrong. */
const PLANTED: [Doc, string, string][] = [
  ['report', '| 193 s | 9 (3 timed out)', '| 193 s | 8 (3 timed out)'],
  ['report', 'at least 0.41 USD', 'at least 0.40 USD'],
  ['report', '| 0.62 USD | 1:', '| 0.26 USD | 1:'],
  ['report', 'Six tool uses were refused', 'Seven tool uses were refused'],
  ['report', '71,725 tokens and 8 model calls', '71,752 tokens and 8 model calls'],
  ['report', '0.24 USD, 48,000 tokens and 2 calls', '0.24 USD, 84,000 tokens and 2 calls'],
  ['report', 'after about 22 s each', 'after about 12 s each'],
  ['report', 'took 37.8 s against a time allowance of 21.6 s', 'took 27.8 s against a time allowance of 21.6 s'],
  ['report', '| `live-improve` | 1 | 1.00 | holdout-A | 0.50 → 0.9625', '| `live-improve` | 1 | 1.00 | holdout-A | 0.50 → 0.9725'],
  ['report', '95% interval 0.40 to 0.625, n=80) | 0.95', '95% interval 0.41 to 0.625, n=80) | 0.95'],
  ['report', 'blocked 3 of the 6 changes', 'blocked 4 of the 6 changes'],
  ['report', 'adds one step to every review (2 to 3)', 'adds one step to every review (2 to 4)'],
  ['report', 'one observation on 60 fresh cases', 'one observation on 600 fresh cases'],
  ['report', '0.32 to 0.42 USD', '0.32 to 0.52 USD'],
  ['report', '158 events, chain intact', '159 events, chain intact'],
  ['report', '8 worker processes', '9 worker processes'],
  ['report', 'sign test 11 better, 2 worse', 'sign test 12 better, 2 worse'],
  ['report', '(0.42 to 25.4)', '(1.42 to 25.4)'],
  ['report', '| Units used | 712 | 656 |', '| Units used | 712 | 650 |'],
  ['report', 'blocked 13.5% of safe changes', 'blocked 3.5% of safe changes'],
  ['report', 'Worker invocations per mission 12.9 → 10.0', 'Worker invocations per mission 12.8 → 10.0'],
  ['report', '5 of 8 without', '6 of 8 without'],
  ['report', 'seven on fixtures, two in testbeds', 'eight on fixtures, one in testbeds'],
  ['report', '4, 2 and 1 reworks', '4, 3 and 1 reworks'],
  ['handoff', '(accuracy 0.49 → 1.00)', '(accuracy 0.59 → 1.00)'],
  ['handoff', 'it blocked 10% of safe changes', 'it blocked 1% of safe changes'],
  ['guide', '| Delegated layers | 3 |', '| Delegated layers | 4 |'],
  ['guide', '| Worker time per mission | 30 minutes', '| Worker time per mission | 60 minutes'],
];

// What the report says about this check is checked too.
claim('report', 'tests/report.test.ts', () => `checks ${claims.length} fragments of this report`);
claim('report', 'tests/report.test.ts', () => `plants ${PLANTED.length} wrong figures`);

/** Every claim a set of documents does not satisfy. `docs` holds each document's text with whitespace collapsed. */
function unsatisfied(docs: Record<Doc, string>): string[] {
  const wrong: string[] = [];
  for (const c of claims) {
    let expected: string;
    try {
      expected = flat(c.says());
    } catch (err) {
      wrong.push(`${DOCS[c.doc]}: a claim about ${c.from} could not be rebuilt (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
      continue;
    }
    if (!docs[c.doc].includes(expected)) wrong.push(`${DOCS[c.doc]} does not say what ${c.from} shows. Expected to find: ${expected}`);
  }
  return wrong;
}
const documents = (): Record<Doc, string> => Object.fromEntries(Object.entries(DOCS).map(([k, p]) => [k, flat(text(p))])) as Record<Doc, string>;

test('the documents say what the evidence files say', () => {
  const wrong = unsatisfied(documents());
  assert.equal(wrong.length, 0, `\n${wrong.join('\n')}\n`);
  assert.ok(claims.length >= 100, `${claims.length} claims checked`);
});

test('a wrong figure planted in a document is caught', () => {
  const clean = documents();
  assert.deepEqual(unsatisfied(clean), [], 'nothing is flagged before anything is planted');
  for (const [doc, right, wrong] of PLANTED) {
    assert.ok(clean[doc].includes(right), `${DOCS[doc]} states: ${right}`);
    const flagged = unsatisfied({ ...clean, [doc]: clean[doc].split(right).join(wrong) });
    assert.ok(flagged.length > 0, `planting "${wrong}" in ${DOCS[doc]} went unnoticed`);
  }
});

test('every evidence bundle the report cites exists and is labeled for what it is', () => {
  for (const d of 'abcdefghi') {
    assert.ok(existsSync(join(REPO_ROOT, `evidence/demo-${d}/README.md`)));
    const labels = (json(`evidence/demo-${d}/summary.json`).labels as string[]).join(' ');
    assert.match(labels, /FIXTURE|SIMULATION|INJECTED|SYNTHETIC/, `demonstration ${d} says it is not live execution`);
  }
  for (const x of LIVE) assert.match(live(x).label, /^LIVE MODEL EXECUTION on SYNTHETIC/);
  for (const x of ['live-improve', 'live-improve-2']) assert.match(json(`evidence/${x}/summary.json`).label, /^LIVE MODEL AUTHOR; SYNTHETIC/);
});
