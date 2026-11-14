import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEV_PROFILE, REPO_ROOT } from '../src/config.ts';

/**
 * The documents quote figures; the figures live in `evidence/`. Each claim below rebuilds a
 * sentence fragment from the evidence files and requires the document to contain exactly that.
 * A claim says what a document must say given the evidence. It cannot say whether the document's
 * interpretation is fair: that still takes a reader.
 *
 * Figures that legitimately differ from run to run (timings, and the regression a canary measures
 * on freshly drawn cases) are quoted in the documents as approximate, and checked here as a band,
 * so that `npm run demo:all` followed by this check passes unless something real has changed.
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
interface Claim {
  doc: keyof typeof DOCS;
  from: string;
  says: () => string;
}
const claims: Claim[] = [];
const claim = (doc: keyof typeof DOCS, from: string, says: () => string): void => void claims.push({ doc, from, says });
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

const live = (x: string): Json => json(`evidence/${x}/summary.json`);
const OUTCOME: Record<string, string> = { blocked: 'Blocked', review_ready: 'Reached review' };
for (const x of ['live-a', 'live-b', 'live-c']) {
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
  const sla = live('live-a').acceptance.find((a: Json) => a.verdict === 'fail');
  assert.deepEqual(sla.verdict_history, ['fail', 'fail', 'fail']);
  return `passed; one failed ${word(sla.verdict_history.length)} times`;
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
  const models = new Set(['live-a', 'live-b', 'live-c'].flatMap((x) => live(x).execution.models_served));
  return `Models served were recorded per attempt: ${[...models].sort().map((m) => `\`${m}\``).join(' and ')}.`;
});
claim('report', 'evidence/live-b/summary.json', () => {
  const stopped = live('live-b').attempts.filter((a: Json) => a.error === 'timeout');
  const done = live('live-b').attempts.filter((a: Json) => a.provider !== 'fixture' && a.error === null);
  return `covers the ${word(done.length)} attempts that completed, and the ${word(stopped.length)} that were stopped at their deadline`;
});
claim('report', 'evidence/live-*/summary.json', () => {
  const all = ['live-a', 'live-b', 'live-c'].map(live);
  assert.ok(all.every((s) => s.integration_failures === 0), 'no integration failure in any live run');
  assert.ok(all.every((s) => s.rework.every((r: Json) => r.why.startsWith('independent acceptance failed'))), 'all rework followed an acceptance failure');
  assert.ok(all.every((s) => s.acceptance.some((a: Json) => a.verdict_history[0] === 'fail')), 'the first integrated result failed a hidden criterion in every run');
  return 'In all three runs the two independently written';
});
claim('report', 'evidence/live-*/summary.json', () => {
  const n = ['live-a', 'live-b', 'live-c'].reduce((a, x) => a + live(x).harness_denials.reduce((b: number, d: Json) => b + d.count, 0), 0);
  return `${cap(word(n))} tool uses were refused across the runs`;
});
claim('report', 'evidence/live-b/summary.json', () => {
  const s = live('live-b').budget.spent;
  return `Its \`budget.spent\` block reads ${f(s.cost_usd_est, 2)} USD, ${s.tokens.toLocaleString('en-US')} tokens and ${s.model_calls} model calls.`;
});
claim('report', 'evidence/live-b/summary.json', () => {
  const s = live('live-b');
  const reported = s.attempts.reduce((a: number, t: Json) => a + (t.cost_usd_list_price_estimate ?? 0), 0);
  const calls = s.attempts.filter((a: Json) => a.provider !== 'fixture' && a.error === null).length;
  return `Of that, ${f(s.budget.spent.cost_usd_est - reported, 2)} USD, 48,000 tokens and ${s.budget.spent.model_calls - calls} calls are two transfers`;
});
claim('report', 'evidence/live-b/summary.json', () => `\`live-b\`'s bundle counts ${word(live('live-b').acceptance_failures)} acceptance failures`);
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
  for (const x of ['live-a', 'live-b', 'live-c']) {
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
claim('report', 'evidence/live-c/summary.json', () => {
  const s = live('live-c');
  return `\`live-c\`: ${s.budget.spent.worker_invocations} worker invocations, ${s.budget.spent.model_calls} model calls, ${f(s.execution.tokens_out / 1000, 1)}k output tokens, ${f(s.execution.cost_usd_list_price_estimate, 2)} USD estimate`;
});
claim('report', 'evidence/live-*/summary.json', () => {
  const rounds = ['live-a', 'live-b', 'live-c'].map((x) => Math.max(...live(x).acceptance.map((a: Json) => a.verdict_history.filter((v: string) => v === 'fail').length)));
  return `${rounds[0]}, ${rounds[1]} and ${rounds[2]} failed acceptance rounds`;
});
claim('report', 'evidence/live-*/summary.json', () => {
  const all = ['live-a', 'live-b', 'live-c'].map(live);
  return `0 integration failures; ${all[0].rework.length}, ${all[1].rework.length} and ${all[2].rework.length} reworks`;
});
claim('report', 'evidence/live-*/summary.json', () => {
  const all = ['live-a', 'live-b', 'live-c'].map(live);
  return `0 corrections; ${all[0].waiting_for_a_person}, ${all[1].waiting_for_a_person} and ${all[2].waiting_for_a_person} decisions waiting`;
});
claim('report', 'evidence/live-*/summary.json', () => {
  const t = ['live-a', 'live-b', 'live-c'].map((x) => Number(secs(live(x).elapsed_ms)));
  return `| ${Math.min(...t)} to ${Math.max(...t)} s |`;
});
claim('report', 'evidence/live-*/summary.json', () => {
  const reached = ['live-a', 'live-b', 'live-c'].filter((x) => live(x).reached_review).length;
  return `${reached} reached review; ${3 - reached} stopped for a person`;
});

// ───────── a model as improvement author (§2.2) ─────────

const author1 = (): Json => json('evidence/live-improve/summary.json');
const author2 = (): Json => json('evidence/live-improve-2/summary.json');
const cmp = (gate: Json, metric: string): Json => gate.comparisons.find((c: Json) => c.metric === metric);
const trim = (n: number): string => (Number.isInteger(n) ? String(n) : String(n));
const improveRow = (label: string, round: string, a: Json, gate: Json, extra: string): string => {
  const acc = cmp(gate, 'accuracy');
  const esc = cmp(gate, 'escaped_defect_rate');
  const fa = cmp(gate, 'false_alarm_rate');
  return `| \`${label}\` | ${round} | ${f(a.report.development_accuracy, 2)} | ${gate.holdout_set} | ${trim(acc.incumbent) === '0.5' ? '0.50' : trim(acc.incumbent)} → ${acc.candidate === 1 ? '1.00' : trim(acc.candidate)}${extra} | ${f(esc.incumbent, 2)} → ${trim(esc.candidate)} | ${trim(fa.incumbent)} → ${fa.candidate === 0 ? '0' : `**${f(fa.candidate, 2)}**`} | **${cap(gate.decision)}**`;
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
claim('report', 'evidence/live-improve*/summary.json', () => {
  const rounds = [author1().author, ...author2().rounds.map((r: Json) => r.author)];
  assert.ok(rounds.every((r: Json) => r.models_served.join() === 'claude-opus-5-5'));
  const s = rounds.map((r: Json) => Math.round(r.wall_ms / 1000));
  const c = rounds.map((r: Json) => r.cost_usd_list_price_estimate as number);
  return `Author effort: ${Math.min(...s)} to ${Math.max(...s)} seconds and ${f(Math.min(...c), 2)} to ${f(Math.max(...c), 2)} USD (list-price estimate) per round.`;
});
claim('report', 'evidence/live-improve*/summary.json', () => {
  const rounds = [author1().author, ...author2().rounds.map((r: Json) => r.author)];
  const denials = rounds.flatMap((r: Json) => r.denials);
  assert.ok(denials.every((d: Json) => d.tool === 'Bash' && d.target.includes('node -e')), 'each refused use was an ad hoc node -e script');
  return `The harness refused ${word(denials.length)} tool uses by the author across the runs`;
});
claim('report', 'evidence/live-improve*/summary.json', () => {
  const rounds = [author1().author, ...author2().rounds.map((r: Json) => r.author)];
  const accepted = [author1().gate, ...author2().rounds.map((r: Json) => r.gate)].filter((g: Json) => g.decision === 'accept').length;
  const cost = rounds.reduce((a: number, r: Json) => a + r.cost_usd_list_price_estimate, 0);
  return `${accepted} accepted of ${rounds.length} model-written candidates, for about ${f(cost, 1)} USD of author time`;
});
claim('report', 'evidence/live-improve/summary.json', () => {
  const j = author1().gate.justification as string;
  assert.match(j, /candidate 10\.0%, incumbent 0\.0%; allowed margin 5\.0%/);
  assert.equal(author2().rounds[0].gate.justification, j);
  return 'they blocked 10% of safe changes on held-out cases. The allowed increase is 5%.';
});
claim('report', 'evidence/live-improve-2/round-2/authored/TASK.md', () => {
  const task = text('evidence/live-improve-2/round-2/authored/TASK.md');
  assert.match(task, /you will not be told which ones went wrong/);
  assert.match(task, /accuracy 0\.5 for the current skill and 0\.9625 with your check; share of breaking changes approved 0\.8 and 0; share of safe changes blocked 0 and 0\.1/);
  return `The revision was written from the gate's aggregate result only (the decision and three rates).`;
});
claim('report', 'evidence/live-improve-2/README.md', () => {
  assert.match(text('evidence/live-improve-2/README.md'), /Canary on fresh cases: \*\*retained\*\*\. Active release afterwards: r2\./);
  return 'retained; the active release became `r2` in that state directory';
});
claim('handoff', 'evidence/live-improve-2/summary.json', () => {
  const a = cmp(author2().rounds[1].gate, 'accuracy');
  return `(accuracy ${f(a.incumbent, 2)} → ${f(a.candidate, 2)})`;
});

// ───────── fixture demonstrations (§3) ─────────

const index = (): Json => json('evidence/summary.json');
const demo = (d: string): Json => index().results.find((r: Json) => r.demo === d);
for (const [d, title] of [['a', 'A. Cross-swarm delivery'], ['b', 'B. Failure recovery'], ['e', 'E. Rejection'], ['f', 'F. Isolation'], ['g', 'G. Canary and rollback']] as const) {
  claim('report', 'evidence/summary.json', () => {
    const r = demo(d);
    assert.equal(r.held, r.checks, `every check of demonstration ${d} held`);
    return `**${title} — ${r.held} of ${r.checks}${d === 'a' ? ' checks' : ''}.**`;
  });
}
claim('report', 'evidence/summary.json', () => {
  assert.ok(index().results.every((r: Json) => r.ok && r.held === r.checks), 'every check of every demonstration held');
  assert.equal(index().results.length, 9);
  return 'Nine fixture demonstrations, two live drivers';
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
  within(demo('a').ms, 2000, 6000, 'the run time of demonstration A in ms');
  return 'A: about 3 s (scripted durations)';
});
claim('report', 'evidence/demo-b/summary.json', () => {
  const o = observed('b', 'duplicate delivery');
  return `${word(num(o, /^(\d+) redelivered requests ignored/))} redelivered requests were ignored`;
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
  within(o.value, 2 * o.threshold, 1, 'the injected accuracy drop');
  return `An injected regression produced an accuracy drop well above the limit of ${o.threshold}`;
});
claim('report', 'evidence/demo-g/summary.json', () => {
  const m = /^(\d+) missions .*?, (\d+) artifacts, (\d+) memories/.exec(observed('g', 'are identified'))!;
  return `${m[1]} missions, ${m[2]} artifacts and ${m[3]} memories that depended on the withdrawn release were identified and marked`;
});

// ───────── simulations and testbeds (§4) ─────────

claim('report', 'evidence/demo-c/summary.json', () => {
  const first = /accuracy ([\d.]+) → ([\d.]+), but Share of safe changes blocked: candidate ([\d.]+)%/.exec(observed('c', 'helps but harms'))!;
  return `A first candidate raised held-out accuracy from ${f(Number(first[1]), 2)} to ${f(Number(first[2]), 2)} but blocked ${Number(first[3])}% of safe changes and was rejected.`;
});
claim('report', 'evidence/demo-c/summary.json', () => {
  const m = /accuracy ([\d.]+) → ([\d.]+) \(difference ([\d.]+), 95% interval ([\d.]+) to ([\d.]+), n=(\d+)\)/.exec(observed('c', 'fixed original baseline'))!;
  return `went from ${m[1]} to ${f(Number(m[2]), 2)} (difference ${m[3]}, 95% interval ${f(Number(m[4]), 2)} to ${m[5]}, n=${m[6]}), was accepted, survived a canary and was retained.`;
});
const dBenefit = (): RegExpExecArray => /validated benefit ([\d.]+) → ([\d.]+) per 100 reviews \(difference ([\d.]+), 95% interval ([\d.-]+) to ([\d.-]+)\); sign test: (\d+) better, (\d+) worse, (\d+) same, p=([\d.]+)/.exec(observed('d', 'independently validated improvement'))!;
claim('report', 'evidence/demo-d/summary.json', () => {
  const m = dBenefit();
  return `| Independently validated benefit per 100 reviews | ${f(Number(m[1]), 1)} | ${f(Number(m[2]), 1)} | +${f(Number(m[3]), 1)} (${f(Number(m[4]), 2)} to ${f(Number(m[5]), 1)}); sign test ${m[6]} better, ${m[7]} worse, ${m[8]} same, p=${f(Number(m[9]), 3)} |`;
});
claim('report', 'evidence/demo-d/summary.json', () => {
  const m = /fixes that failed: ([\d.]+) → ([\d.]+) units per campaign \(difference (-[\d.]+), 95% interval (-[\d.]+) to (-[\d.]+)\)/.exec(observed('d', 'unsuccessful experiments'))!;
  const neg = (x: string): string => `−${f(Math.abs(Number(x)), 1)}`;
  return `| Budget spent on fixes that failed | ${f(Number(m[1]), 1)} | ${f(Number(m[2]), 1)} | ${neg(m[3]!)} (${neg(m[4]!)} to ${neg(m[5]!)}) |`;
});
claim('report', 'evidence/demo-d/summary.json', () => {
  const m = /(\d+) episodes from held-out set arena-A; budget (\d+) units each; mean spent ([\d.]+) \(incumbent\) and ([\d.]+) \(candidate\)/.exec(observed('d', 'equal budgets'))!;
  return `| Budget spent | ${f(Number(m[3]), 1)} | ${f(Number(m[4]), 1)} | |`;
});
claim('report', 'evidence/demo-d/summary.json', () => {
  const m = /(\d+) episodes from held-out set arena-A; budget (\d+) units each/.exec(observed('d', 'equal budgets'))!;
  return `equal budgets of ${m[2]} units, the same ${m[1]} unseen failure episodes`;
});
claim('report', 'evidence/demo-d/summary.json', () => {
  const m = /difference ([\d.]+) \(95% interval (-?[\d.]+) to ([\d.]+)\)\. In (\d+) of (\d+) episodes/.exec(observed('d', 'sensitivity check'))!;
  const lo = Number(m[2]);
  return `the advantage is **not demonstrated** (+${f(Number(m[1]), 1)}, interval ${lo < 0 ? '−' : ''}${f(Math.abs(lo) + 1e-9, 1)} to ${f(Number(m[3]) + 1e-9, 1)}). In ${m[4]} of ${m[5]} episodes the new policy did worse.`;
});
claim('report', 'evidence/demo-d/summary.json', () => `The interval's lower bound is ${f(Number(dBenefit()[4]), 2)}.`);
claim('report', 'evidence/demo-d/summary.json', () => {
  const m = dBenefit();
  return `D: ${f(Number(m[2]), 1)} against ${f(Number(m[1]), 1)} per 420 units`;
});

const portfolio = (arm: 'control' | 'trial'): Json => json(`evidence/demo-i/portfolio-${arm}.json`);
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
void portfolio;

const hSelf = (): string => observed('h', 'really is cheaper and faster');
claim('report', 'evidence/demo-h/summary.json', () => {
  const m = /worker invocations per mission ([\d.]+) → ([\d.]+)/.exec(hSelf())!;
  return `Worker invocations per mission ${f(Number(m[1]) + 1e-9, 1)} → ${f(Number(m[2]), 1)};`;
});
claim('report', 'evidence/demo-h/summary.json', () => {
  const m = /completion (\d+) ms → (\d+) ms/.exec(hSelf())!;
  within(Number(m[1]), 3300, 5500, 'completion time with verification in ms');
  within(Number(m[2]), 2300, 3900, 'completion time without verification in ms');
  assert.ok(Number(m[2]) < Number(m[1]));
  return 'completion about 4 s → 3 s';
});
claim('report', 'evidence/demo-h/summary.json', () => {
  const m = /per mission (\d+) → ([\d.]+); truly correct missions (\d+) → ([\d.]+) \(difference (-[\d.]+), 95% interval (-[\d.]+) to (-[\d.]+)\)/.exec(observed('h', 'measured by an oracle'))!;
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
  const m = /candidate (\d+), incumbent (\d+), across (\d+) episodes/.exec(observed('h', 'The decision follows the frozen rule'))!;
  return `H: ${m[2]} escapes with verification, ${m[1]} in ${m[3]} missions without`;
});
claim('report', 'evidence/demo-h/summary.json', () => `${cap(word(num(observed('h', 'same seeded missions'), /^(\d+) complete fixture missions per configuration/)))} complete fixture missions per configuration`);

// ───────── tests, handoff, operator guide ─────────

const testCount = (): number =>
  readdirSync(join(REPO_ROOT, 'tests'))
    .filter((x) => x.endsWith('.test.ts'))
    .reduce((a, x) => a + (text(`tests/${x}`).match(/^test\(/gm) ?? []).length, 0);
claim('report', 'tests/*.test.ts', () => `| Tests for coordination, recovery, isolation, rollback | ${testCount()} tests, all passing |`);
claim('report', 'tests/*.test.ts', () => `**Tests.** ${testCount()} tests pass`);
claim('report', 'tests/*.test.ts', () => `npm test # ${testCount()} tests`);
claim('handoff', 'tests/*.test.ts', () => `${word(index().results.length)} demonstrations and ${testCount()} tests`);
claim('guide', 'tests/*.test.ts', () => `npm test # ${testCount()} tests`);
claim('readme', 'tests/*.test.ts', () => `npm test # ${testCount()} tests`);
claim('progress', 'tests/*.test.ts', () => `npm test # ${testCount()} tests`);
claim('guide', 'src/config.ts', () => `| Concurrent model calls | ${DEV_PROFILE.max_concurrent_model_calls} |`);
claim('guide', 'src/config.ts', () => `| Delegated layers | ${DEV_PROFILE.max_delegation_depth} |`);
claim('guide', 'src/config.ts', () => `| Worker invocations per mission | ${DEV_PROFILE.max_worker_invocations} `);
claim('guide', 'src/config.ts', () => `| Wall-clock per mission | ${DEV_PROFILE.max_wall_ms / 60_000} minutes of running time |`);
claim('guide', 'src/config.ts', () => `| Retries / repair attempts per task | ${DEV_PROFILE.max_retries_per_task} / ${DEV_PROFILE.max_repair_attempts} |`);
claim('guide', 'src/config.ts', () => `| Reserved for verification / recovery / completion | ${DEV_PROFILE.reserve.verification * 100}% / ${DEV_PROFILE.reserve.recovery * 100}% / ${DEV_PROFILE.reserve.completion * 100}% |`);
claim('guide', 'src/config.ts', () => `| Lease / heartbeat | ${DEV_PROFILE.lease_ms / 1000} s / ${DEV_PROFILE.heartbeat_ms / 1000} s |`);
claim('guide', 'src/config.ts', () => `| Minimum time for one live attempt | ${DEV_PROFILE.live_attempt_floor_ms / 60_000} minutes |`);
claim('guide', 'protected/policy.json', () => `| Experiment allocation | ${(json('protected/policy.json').exploration.budget_units as number).toLocaleString('en-US')} experiment units in total |`);

test('the documents say what the evidence files say', () => {
  const docs = Object.fromEntries(Object.entries(DOCS).map(([k, p]) => [k, flat(text(p))]));
  const wrong: string[] = [];
  for (const c of claims) {
    let expected: string;
    try {
      expected = flat(c.says());
    } catch (err) {
      wrong.push(`${DOCS[c.doc]}: a claim about ${c.from} could not be rebuilt (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
      continue;
    }
    if (docs[c.doc]!.includes(expected)) continue;
    wrong.push(`${DOCS[c.doc]} does not say what ${c.from} shows. Expected to find: ${expected}`);
  }
  assert.equal(wrong.length, 0, `\n${wrong.join('\n')}\n`);
  assert.ok(claims.length >= 80, `${claims.length} claims checked`);
});

test('every evidence bundle the report cites exists and is labeled for what it is', () => {
  for (const d of 'abcdefghi') {
    assert.ok(existsSync(join(REPO_ROOT, `evidence/demo-${d}/README.md`)));
    const labels = (json(`evidence/demo-${d}/summary.json`).labels as string[]).join(' ');
    assert.match(labels, /FIXTURE|SIMULATION|INJECTED|SYNTHETIC/, `demonstration ${d} says it is not live execution`);
  }
  for (const x of ['live-a', 'live-b', 'live-c']) assert.match(live(x).label, /^LIVE MODEL EXECUTION on SYNTHETIC/);
  for (const x of ['live-improve', 'live-improve-2']) assert.match(json(`evidence/${x}/summary.json`).label, /^LIVE MODEL AUTHOR; SYNTHETIC/);
});
