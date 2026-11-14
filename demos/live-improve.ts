/**
 * LIVE first-order improvement — a real model in the candidate author's seat.
 *
 *   SWARM2_LIVE=1 node demos/live-improve.ts [name]
 *
 * The organization observes failures of its change-review skill on development work. A model
 * author is then given those observations and labeled DEVELOPMENT cases only, in a workspace of
 * its own, and writes a new executable check for the skill. The release gate evaluates what it
 * wrote on held-out cases the author never had, and decides.
 *
 * What is live: the author. What is not: the review workload is synthetic, and the gate's
 * evaluation executes the checks on cases — no model is run to judge anything.
 *
 * Evidence is written to evidence/<name>/ (default: live-improve).
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/config.ts';
import type { ExecutionDef } from '../src/contracts/definitions.ts';
import type { CandidateSpec } from '../src/evolution/candidates.ts';
import { observeReviewWork, runExperiment } from '../src/evolution/loop.ts';
import { renderManifest, renderReceipt } from '../src/evolution/receipts.ts';
import { Gate } from '../src/gate/gate.ts';
import { devCases } from '../fixtures/evolution/review-cases.ts';
import { freshHome, writeEvidence } from './lib.ts';

const name = process.argv[2] ?? 'live-improve';
const TIMEOUT_MS = Number(process.env.SWARM2_LIVE_MAX_MS ?? 12 * 60_000);

const CHECK_SCRIPT = `// Development check. Runs the skill's current checks plus anything in candidate/validators on the
// labeled development cases and prints how the combined skill does. Run it with: node check.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs';
const def = JSON.parse(readFileSync('skill/execution.json', 'utf8'));
const files = [
  ...def.skills['change-review'].validators.map((f) => './skill/validators/' + f),
  ...(existsSync('candidate/validators') ? readdirSync('candidate/validators').filter((f) => f.endsWith('.mjs')).sort().map((f) => './candidate/validators/' + f) : []),
];
const mods = [];
for (const f of files) mods.push({ f, m: await import(f) });
const cases = JSON.parse(readFileSync('dev-cases.json', 'utf8'));
let correct = 0, escaped = 0, falseAlarm = 0, blocking = 0, safe = 0;
const wrong = [];
const errors = new Set();
for (const { case: c, label } of cases) {
  const findings = [];
  for (const { f, m } of mods) {
    try { for (const x of m.check(structuredClone(c)) ?? []) findings.push(x); } catch (e) { errors.add(f + ': ' + String(e && e.message ? e.message : e).slice(0, 160)); }
  }
  const blockers = findings.filter((x) => x.severity === 'blocking');
  const blocked = blockers.length > 0;
  const named = label.field === null ? null : blockers.some((x) => x.field === label.field || String(x.field ?? '').endsWith('.' + label.field));
  const ok = label.should_block ? blocked && named !== false : !blocked;
  if (label.should_block) blocking++; else safe++;
  if (ok) correct++;
  else wrong.push({ id: c.id, class: label.defect_class, should_block: label.should_block, field: label.field, blocked, fields_named: blockers.map((x) => x.field) });
  if (label.should_block && !blocked) escaped++;
  if (!label.should_block && blocked) falseAlarm++;
}
console.log(JSON.stringify({ checks: files, cases: cases.length, accuracy: +(correct / cases.length).toFixed(4), breaking_changes_approved: escaped + ' of ' + blocking, safe_changes_blocked: falseAlarm + ' of ' + safe, errors: [...errors], wrong: wrong.slice(0, 20) }, null, 1));
`;

const AUTHOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hypothesis', 'change_summary', 'procedure_step', 'known_failure_cases', 'development_accuracy', 'remaining_uncertainty'],
  properties: {
    hypothesis: { type: 'string', description: 'A falsifiable statement: if the skill also does X, then Y will change.' },
    change_summary: { type: 'string' },
    procedure_step: { type: 'string', description: 'One sentence a reviewer would follow, describing the new step.' },
    known_failure_cases: { type: 'array', items: { type: 'string' } },
    development_accuracy: { type: 'number' },
    remaining_uncertainty: { type: 'array', items: { type: 'string' } },
  },
} as const;

interface AuthorResult {
  ok: boolean;
  error: string | null;
  report: { hypothesis: string; change_summary: string; procedure_step: string; known_failure_cases: string[]; development_accuracy: number; remaining_uncertainty: string[] } | null;
  model_requested: string;
  models_served: string[];
  session_id: string | null;
  wall_ms: number;
  turns: number | null;
  output_tokens: number | null;
  cost_usd_list_price_estimate: number | null;
  denials: { tool: string; target: string }[];
  development_check_runs: number;
}

function runAuthor(ws: string, model: string, prompt: string): Promise<AuthorResult> {
  const started = Date.now();
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(AUTHOR_SCHEMA), '--model', model, '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', '', '--tools', 'Read,Write,Edit,Glob,Grep,Bash', '--allowedTools', 'Read(./**)', 'Glob(./**)', 'Grep(./**)', 'Edit(./candidate/**)', 'Write(./candidate/**)', 'Bash(node check.mjs:*)'];
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd: ws, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let buffer = '';
    let final: Record<string, unknown> | null = null;
    let checks = 0;
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as { type?: string; message?: { content?: { type?: string; name?: string; input?: { command?: string } }[] } };
          if (ev.type === 'result') final = ev as Record<string, unknown>;
          for (const b of ev.message?.content ?? []) if (b.type === 'tool_use' && b.name === 'Bash' && /node check\.mjs/.test(b.input?.command ?? '')) checks++;
        } catch {
          /* partial line */
        }
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      const f = (final ?? {}) as { is_error?: boolean; result?: unknown; structured_output?: AuthorResult['report']; session_id?: string; num_turns?: number; total_cost_usd?: number; usage?: { output_tokens?: number }; modelUsage?: Record<string, unknown>; permission_denials?: { tool_name?: string; tool_input?: Record<string, unknown> }[] };
      resolve({
        ok: Boolean(final) && !f.is_error && Boolean(f.structured_output),
        error: !final ? 'the author process ended without a result' : f.is_error ? String(f.result ?? 'error') : f.structured_output ? null : 'no schema-valid report',
        report: f.structured_output ?? null,
        model_requested: model,
        models_served: Object.keys(f.modelUsage ?? {}),
        session_id: f.session_id ?? null,
        wall_ms: Date.now() - started,
        turns: f.num_turns ?? null,
        output_tokens: f.usage?.output_tokens ?? null,
        cost_usd_list_price_estimate: typeof f.total_cost_usd === 'number' ? Number(f.total_cost_usd.toFixed(4)) : null,
        denials: (f.permission_denials ?? []).map((d) => ({ tool: String(d.tool_name), target: String(d.tool_input?.file_path ?? d.tool_input?.path ?? d.tool_input?.pattern ?? d.tool_input?.command ?? '').slice(0, 240) })),
        development_check_runs: checks,
      });
    });
  });
}

async function main(): Promise<void> {
  if (process.env.SWARM2_LIVE !== '1') {
    process.stderr.write('Live execution is off. This run uses real model calls; set SWARM2_LIVE=1 to allow it.\n');
    process.exit(2);
  }
  const out = join(REPO_ROOT, 'evidence', name);
  rmSync(out, { recursive: true, force: true });
  const rt = freshHome(join(REPO_ROOT, 'var', name));
  const gate = new Gate(rt);
  gate.init();
  try {
    // 1. Observe: the incumbent skill's failures on development work.
    const seen = await observeReviewWork(rt, gate);
    process.stdout.write(`Observed ${seen.observation_ids.length} verified failures in ${seen.reviewed} development reviews: ${JSON.stringify(seen.by_class)}\n`);

    // 2. The author's workspace: the skill as it is, labeled development cases, and a development check.
    const active = rt.registry.manifest(rt.registry.active());
    const parentDir = rt.registry.componentDir('execution', active.components.execution.version);
    const def = JSON.parse(readFileSync(join(parentDir, 'execution.json'), 'utf8')) as ExecutionDef;
    const skill = def.skills['change-review']!;
    const ws = join(rt.paths.candidates, 'live-author', 'ws');
    rmSync(ws, { recursive: true, force: true });
    mkdirSync(join(ws, 'candidate', 'validators'), { recursive: true });
    cpSync(parentDir, join(ws, 'skill'), { recursive: true });
    const cases = devCases('author-dev-1', 60);
    writeFileSync(join(ws, 'dev-cases.json'), JSON.stringify(cases, null, 1));
    writeFileSync(join(ws, 'observed-failures.json'), JSON.stringify({ note: 'Verified failures of the current skill on earlier development work (a different sample from dev-cases.json).', reviewed: seen.reviewed, accuracy: seen.accuracy, failures_by_class: seen.by_class }, null, 1));
    writeFileSync(join(ws, 'check.mjs'), CHECK_SCRIPT);
    const model = def.routing.by_archetype.evolution?.model ?? def.routing.default.model;
    const prompt = [
      def.agents.evolution?.instructions ?? '',
      '',
      '# Your task',
      'The change-review skill reviews a proposed change to a shared data contract. It runs a list of small checks; if any check returns a blocking finding the change is sent back, otherwise it is approved.',
      `Its current checks are in skill/validators/ and are listed in skill/execution.json. Its own notes say: "${skill.known_failure_cases.join('; ')}".`,
      'observed-failures.json summarizes the verified failures of the current skill. dev-cases.json holds labeled DEVELOPMENT cases: each has the case (contract_before, contract_after, files_changed, a description) and a label (should_block, defect_class, field).',
      '',
      'Write ONE new check as candidate/validators/interface_compat.mjs so that breaking changes to a contract are sent back and safe changes are still approved.',
      '',
      'Rules for the file:',
      '- It exports `id` (a string) and `check(c)`, exactly like the files in skill/validators/. `check` returns an array of findings: { step: id, class, field, severity: "blocking" | "advisory", message }.',
      '- A blocking finding must name the affected field in `field`, as a dot path from the root of the contract (for example "measurements.pressure"). A change blocked for the wrong field counts as wrong.',
      '- Plain JavaScript only. No imports, no file, process, network or dynamic-code access: a check has no reason to use them and the release gate refuses a candidate that does.',
      '- Decide from the structure of contract_before and contract_after. Do not use case ids, titles or descriptions.',
      '',
      'How it will be judged: the release gate will run the skill with your check on HELD-OUT cases you cannot see, which include kinds of change that are not in the development cases. It accepts only if accuracy improves, no more breaking changes are approved, and safe changes are not blocked beyond a small margin. So think about which differences between two schemas are truly breaking for a consumer and which are safe, rather than fitting the development cases.',
      '',
      'Run `node check.mjs` (exactly that command) to see how the skill does on the development cases with your check added. Iterate until you are satisfied, then answer with the structured report. You can only write inside candidate/.',
    ].join('\n');
    const MAX_ROUNDS = Number(process.env.SWARM2_LIVE_ROUNDS ?? 2);
    const rounds: Record<string, unknown>[] = [];
    let previous: { experiment_id: string; feedback: string } | null = null;
    let lastReceipt: Awaited<ReturnType<typeof runExperiment>>['receipt'] | null = null;
    let canary: { status: string; observations: unknown[] } | null = null;
    const lines: string[] = [
      `# Live improvement run: ${name}`,
      '',
      '**LIVE MODEL AUTHOR.** A model wrote each candidate from development cases only. The review workload is SYNTHETIC, and the release gate judged each candidate by executing it on held-out cases — no model took part in the judging.',
      '',
      `Observed first: ${seen.observation_ids.length} verified failures in ${seen.reviewed} development reviews (accuracy ${Math.round(seen.accuracy * 100)}%).`,
      '',
    ];

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      // A revision is told what the gate decided and the aggregate results — never the held-out cases.
      const ask = previous === null ? prompt : [
        def.agents.evolution?.instructions ?? '',
        '',
        '# Your task: revise your candidate',
        'You wrote candidate/validators/interface_compat.mjs for the change-review skill. The release gate evaluated it on held-out cases and did not accept it.',
        '',
        `What the gate reported: ${previous.feedback}`,
        '',
        'You cannot see the held-out cases, and you will not be told which ones went wrong. Reason about which kinds of difference between contract_before and contract_after your check treats as breaking although a consumer of the contract would not be broken by them, and which truly breaking kinds it might miss. The development cases in dev-cases.json do not contain every kind of change.',
        'Revise candidate/validators/interface_compat.mjs in place. The rules are unchanged: it exports `id` and `check(c)`; a blocking finding names the affected field as a dot path; plain JavaScript with no imports and no file, process, network or dynamic-code access; decide from structure only.',
        'Your revision will be judged on a DIFFERENT held-out set. Run `node check.mjs` (exactly that command) to confirm the development cases still pass, then answer with the structured report.',
      ].join('\n');
      process.stdout.write(`Round ${round}: author (${model}) is working in an isolated workspace…\n`);
      const author = await runAuthor(ws, model, ask);
      process.stdout.write(`Round ${round}: author finished: ok=${author.ok}, ${Math.round(author.wall_ms / 1000)} s, ${author.development_check_runs} development check runs, ${author.denials.length} tool uses refused\n`);
      const files = existsSync(join(ws, 'candidate', 'validators')) ? readdirSync(join(ws, 'candidate', 'validators')).filter((f) => f.endsWith('.mjs')) : [];
      const entry: Record<string, unknown> = { round, author: { ...author, files_written: files } };
      rounds.push(entry);
      if (!author.ok || !author.report || files.length === 0) {
        entry.outcome = `no candidate was submitted: ${author.error ?? 'the author wrote no check'}`;
        lines.push(`## Round ${round}`, '', `No candidate was submitted: ${author.error ?? 'the author wrote no check'}.`, '');
        break;
      }

      // Package what the author wrote as a candidate and hand it to the gate.
      const specDir = join(rt.paths.candidates, 'live-author', `spec-${round}`);
      rmSync(specDir, { recursive: true, force: true });
      mkdirSync(join(specDir, 'files', 'validators'), { recursive: true });
      for (const f of files) cpSync(join(ws, 'candidate', 'validators', f), join(specDir, 'files', 'validators', f));
      const spec: CandidateSpec = {
        candidate_id: round === 1 ? 'live-authored-interface-check' : `live-authored-interface-check-rev${round - 1}`,
        level: 'execution',
        title: `Interface compatibility check for change review (written by a model author${round > 1 ? ', revised after a rejection' : ''})`,
        problem: `Reviews with release ${active.release_id} got ${seen.observation_ids.length} of ${seen.reviewed} development reviews wrong: ${Object.entries(seen.by_class).map(([k, v]) => `${k}×${v}`).join(', ')}.`,
        failure_classes: Object.keys(seen.by_class),
        hypothesis: author.report.hypothesis,
        expected_benefit: 'Fewer approved breaking changes, with safe changes still approved.',
        possible_regressions: ['Safe changes could be blocked', 'Each review runs one more step', ...author.report.remaining_uncertainty.slice(0, 3)],
        change_summary: author.report.change_summary,
        revises: round === 1 ? null : 'live-authored-interface-check',
        declared_simplification: false,
        skill_patch: { skill_id: 'change-review', validators_add: files, validators_remove: [], procedure: [...skill.procedure.slice(0, -1), author.report.procedure_step, ...skill.procedure.slice(-1)], known_failure_cases: author.report.known_failure_cases },
      };
      writeFileSync(join(specDir, 'candidate.json'), JSON.stringify(spec, null, 2) + '\n');
      const r = await runExperiment(rt, gate, spec.candidate_id, { spec_dir: specDir, revises_experiment: previous?.experiment_id ?? null });
      const rec = r.receipt;
      lastReceipt = rec;
      const acc = rec.comparisons.find((c) => c.metric === 'accuracy');
      const fa = rec.comparisons.find((c) => c.metric === 'false_alarm_rate');
      const esc = rec.comparisons.find((c) => c.metric === 'escaped_defect_rate');
      process.stdout.write(`Round ${round}: gate decision: ${rec.decision} — ${rec.justification}\n`);
      entry.gate = {
        experiment_id: r.experiment.id,
        decision: rec.decision,
        justification: rec.justification,
        holdout_set: rec.evaluation.holdout_set,
        isolation_of_candidate_code: rec.isolation,
        comparisons: rec.comparisons.map((c) => ({ metric: c.metric, incumbent: c.incumbent, candidate: c.candidate, difference: c.diff_vs_incumbent, ci95: c.ci95_vs_incumbent, n: c.n })),
        gates_not_passed: rec.gates.filter((g) => g.verdict !== 'PASSED').map((g) => ({ id: g.id, verdict: g.verdict, meaning: g.meaning })),
        development_accuracy_claimed_by_author: author.report.development_accuracy,
        development_accuracy_measured_by_gate: r.dev?.accuracy ?? null,
        release: rec.release_manifest?.release_id ?? null,
      };
      writeEvidence(out, `round-${round}/receipt.json`, rec);
      writeEvidence(out, `round-${round}/receipt.md`, renderReceipt(rec));
      for (const f of files) writeEvidence(out, `round-${round}/authored/${f}`, readFileSync(join(ws, 'candidate', 'validators', f), 'utf8'));
      writeEvidence(out, `round-${round}/authored/author-report.json`, author.report);
      writeEvidence(out, `round-${round}/authored/TASK.md`, ask);
      lines.push(
        `## Round ${round}${round > 1 ? ' (revision)' : ''}`,
        '',
        `- Author: ${author.models_served.join(', ') || model}; ${Math.round(author.wall_ms / 1000)} s; ${author.turns ?? '—'} turns; ${author.development_check_runs} run(s) of the development check; ${author.output_tokens ?? '—'} output tokens; list-price cost estimate ${author.cost_usd_list_price_estimate ?? '—'} USD (not billing).`,
        `- Tool uses refused by the worker harness: ${author.denials.length}${author.denials.length ? ` (${author.denials.map((d) => `${d.tool}: ${d.target.replace(/\s+/g, ' ').slice(0, 110)}`).join('; ')})` : ''}.`,
        `- Hypothesis (the author's): ${author.report.hypothesis}`,
        `- Development accuracy: ${author.report.development_accuracy} claimed by the author; ${r.dev?.accuracy ?? '—'} measured by the gate on a different development sample.`,
        `- **Gate decision: ${rec.decision}.** ${rec.justification}`,
        acc ? `- Held-out accuracy on ${rec.evaluation.holdout_set}: ${acc.incumbent} → ${acc.candidate} (difference ${acc.diff_vs_incumbent}, 95% interval ${acc.ci95_vs_incumbent?.[0]} to ${acc.ci95_vs_incumbent?.[1]}, n=${acc.n}).` : '- No held-out comparison was made.',
        esc ? `- Share of breaking changes approved: ${esc.incumbent} → ${esc.candidate}.` : '',
        fa ? `- Share of safe changes blocked: ${fa.incumbent} → ${fa.candidate}.` : '',
        '',
      );

      if (rec.decision === 'accept' && rec.release_manifest) {
        // An accepted release is tried on fresh cases before it can become the default.
        const c = gate.startCanary(rec.release_manifest.release_id, { max_missions: 0 });
        const observed = await gate.observeCanary(c.id);
        const done = observed.status === 'running' ? gate.retain(c.id) : observed;
        canary = { status: done.status, observations: done.observations };
        entry.canary = canary;
        writeEvidence(out, 'release-manifest.md', renderManifest(rt.registry.manifest(rec.release_manifest.release_id)));
        lines.push(`Canary on fresh cases: **${done.status}**. Active release afterwards: ${rt.registry.active()}.`, '');
        process.stdout.write(`Canary: ${done.status}; active release is now ${rt.registry.active()}\n`);
        break;
      }
      previous = {
        experiment_id: r.experiment.id,
        feedback: `${rec.justification} On the held-out cases: accuracy ${acc?.incumbent} for the current skill and ${acc?.candidate} with your check; share of breaking changes approved ${esc?.incumbent} and ${esc?.candidate}; share of safe changes blocked ${fa?.incumbent} and ${fa?.candidate} (the allowed increase is ${gate.policy().levels.execution.false_alarm_margin}).`,
      };
    }

    const sets = rounds.map((x) => (x.gate as { holdout_set?: string } | undefined)?.holdout_set).filter(Boolean);
    const total = rounds.reduce((a, x) => a + ((x.author as AuthorResult).cost_usd_list_price_estimate ?? 0), 0);
    writeEvidence(out, 'summary.json', {
      label: 'LIVE MODEL AUTHOR; SYNTHETIC review workload; evaluation by executing checks, with no model in the judging',
      ran_at: new Date().toISOString(),
      observed: { reviewed: seen.reviewed, accuracy: seen.accuracy, failures_by_class: seen.by_class },
      author_isolation: 'Harness-level: file tools scoped to the workspace, writes to candidate/ only, one shell command allowed. The author process ran as the operator user, so this is not OS-enforced; refused tool uses are listed per round.',
      rounds,
      held_out_sets_used: sets,
      final_decision: lastReceipt?.decision ?? 'none',
      canary,
      active_release_after: rt.registry.active(),
      author_cost_usd_list_price_estimate_total: Number(total.toFixed(4)),
      ledger_intact: gate.verifyLedger().ok,
      exploration: gate.exploration(),
    });
    lines.push(
      `Held-out sets used by this line of work: ${sets.join(', ') || 'none'}. A revision is never scored on a set its lineage has already seen results for.`,
      `Final decision: **${lastReceipt?.decision ?? 'none'}**. Active release afterwards: ${rt.registry.active()}.`,
      '',
      `Isolation: candidate CODE was executed by the gate in mode \`${lastReceipt?.isolation.mode ?? 'unknown'}\`. The AUTHOR was confined by the worker harness only (file tools scoped to its workspace), not by the operating system; it ran as the operator user.`,
      '',
      'Files: `summary.json`; per round `receipt.md` / `receipt.json` and `authored/` (the check the model wrote, its report, and the task it was given); `release-manifest.md` if a release was created.',
    );
    writeEvidence(out, 'README.md', lines.filter((l) => l !== undefined).join('\n') + '\n');
    process.stdout.write(`→ evidence/${name}/\n`);
  } finally {
    gate.close();
    rt.close();
  }
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack : err) + '\n');
  process.exit(1);
});
