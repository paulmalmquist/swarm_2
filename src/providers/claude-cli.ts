import { spawn } from 'node:child_process';
import { killGroup } from '../security/process.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LimitsProfile, UsageRecord, WorkOutput } from '../contracts/types.ts';
import type { Provider, ProviderHooks, WorkRequest, WorkResult, WorkerHandle } from './provider.ts';

/** JSON Schema a live worker's final answer must satisfy (`claude -p --json-schema`). */
export const WORK_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'artifacts', 'evidence', 'criteria_claims', 'remaining_uncertainty', 'questions', 'proposals'],
  properties: {
    file_changes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: ['string', 'null'] } } } },
    status: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
    summary: { type: 'string' },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'kind', 'media_type'],
        properties: { key: { type: 'string' }, kind: { type: 'string' }, media_type: { type: 'string' }, content: { type: 'string' }, path: { type: 'string' } },
      },
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'statement', 'epistemic', 'origin', 'refs'],
        properties: {
          kind: { type: 'string' },
          statement: { type: 'string' },
          epistemic: { type: 'string', enum: ['observed_fact', 'interpretation'] },
          origin: { type: 'string', enum: ['business', 'agent', 'runtime'] },
          refs: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    criteria_claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion_id', 'claimed', 'note'],
        properties: { criterion_id: { type: 'string' }, claimed: { type: 'string', enum: ['met', 'not_met', 'unknown'] }, note: { type: 'string' } },
      },
    },
    remaining_uncertainty: { type: 'array', items: { type: 'string' } },
    questions: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['to', 'question', 'blocking'], properties: { to: { type: 'string' }, question: { type: 'string' }, blocking: { type: 'boolean' } } },
    },
    proposals: {
      type: 'array',
      items: { type: 'object', required: ['kind', 'payload'], properties: { kind: { type: 'string' }, payload: { type: 'object' } } },
    },
    // No `plan`: in this build the work graph comes from the versioned coordination policy, and a
    // live worker is not asked to propose one. Offering the field invited shapeless objects.
  },
} as const;

interface ClaudeResultEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  api_error_status?: number | null;
  terminal_reason?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; iterations?: unknown[] };
  modelUsage?: Record<string, { outputTokens?: number; costBasis?: string }>;
  subagent_stats?: { spawned?: number };
  permission_denials?: unknown[];
}

/**
 * Turn the final `result` event of `claude -p` into a WorkResult.
 * Pure, so recorded executions can be replayed through it in tests.
 */
export function interpretResult(ev: ClaudeResultEvent | null, meta: { model_requested: string | null; wall_ms: number; exit_code: number | null; signal: string | null; timed_out: boolean; expects_structured: boolean }): WorkResult {
  const base = { self_submitted: false, model_requested: meta.model_requested };
  if (!ev) {
    const status = meta.timed_out ? 'timeout' : meta.signal ? 'killed' : 'failed';
    return { ...base, status, output: null, usage: null, model_actual: null, session_id: null, error: { code: status === 'failed' ? 'no_result' : status, message: `worker ended without a result (exit ${meta.exit_code}, signal ${meta.signal})` } };
  }
  const models = Object.entries(ev.modelUsage ?? {}).sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0));
  const model_actual = models[0]?.[0] ?? null;
  const basis = models[0]?.[1].costBasis;
  const usage: UsageRecord = {
    source: 'claude-cli',
    meter_kind: 'provider_reported',
    call_count: ev.usage?.iterations?.length ?? ev.num_turns ?? 1,
    input_units: ev.usage?.input_tokens ?? null,
    output_units: ev.usage?.output_tokens ?? null,
    cache_read_units: ev.usage?.cache_read_input_tokens ?? null,
    cache_write_units: ev.usage?.cache_creation_input_tokens ?? null,
    wall_ms: meta.wall_ms,
    // `total_cost_usd` is a client-side estimate at list prices, not billing. It is kept as reported.
    reported_cost: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
    currency: typeof ev.total_cost_usd === 'number' ? 'USD' : null,
    cost_basis: typeof ev.total_cost_usd === 'number' && basis !== 'billed' ? 'list_price_estimate' : 'none',
    // The docs state `usage` excludes subagent calls while cost includes them.
    completeness: (ev.subagent_stats?.spawned ?? 0) > 0 ? 'partial' : 'complete',
    observed_at: new Date().toISOString(),
  };
  const denials = ((ev.permission_denials ?? []) as { tool_name?: string; tool_input?: Record<string, unknown> }[]).map((d) => ({
    tool: String(d.tool_name ?? 'unknown'),
    target: String(d.tool_input?.file_path ?? d.tool_input?.path ?? d.tool_input?.pattern ?? d.tool_input?.command ?? '').slice(0, 240),
  }));
  const common = { ...base, usage, model_actual, session_id: ev.session_id ?? null, denials };
  if (ev.is_error) {
    const message = String(ev.result ?? ev.subtype ?? 'error');
    const limited = ev.api_error_status === 429 || /usage limit|rate limit|hit your .*limit/i.test(message);
    return { ...common, status: limited ? 'rate_limited' : 'failed', output: null, error: { code: limited ? 'rate_limited' : `provider_${ev.terminal_reason ?? ev.subtype ?? 'error'}`, message } };
  }
  if (ev.subtype && ev.subtype !== 'success') {
    return { ...common, status: 'failed', output: null, error: { code: ev.subtype, message: String(ev.result ?? ev.subtype) } };
  }
  if (meta.timed_out || meta.signal || meta.exit_code !== 0) return { ...common, status: meta.timed_out ? 'timeout' : 'failed', output: null, error: { code: 'abnormal_exit', message: `Worker exited abnormally (${meta.exit_code}, ${meta.signal})` } };
  if (meta.expects_structured) {
    const out = ev.structured_output as WorkOutput | undefined;
    if (!out || typeof out !== 'object' || typeof out.summary !== 'string' || !Array.isArray(out.artifacts)) {
      return { ...common, status: 'invalid_output', output: null, error: { code: 'invalid_output', message: 'worker finished without a schema-valid structured result' } };
    }
    const { plan: _notAccepted, ...rest } = out as typeof out & { plan?: unknown };
    return { ...common, status: 'ok', output: { ...rest, questions: out.questions ?? [], proposals: out.proposals ?? [] }, error: null };
  }
  return { ...common, status: 'ok', output: { status: 'completed', summary: String(ev.result ?? ''), artifacts: [], evidence: [], criteria_claims: [], remaining_uncertainty: [], questions: [], proposals: [] }, error: null };
}

export function buildPrompt(req: WorkRequest): string {
  const c = req.task.contract;
  const lines: string[] = [];
  lines.push(`You are the ${c.assignee.role} in the ${c.assignee.archetype} swarm of an agent organization. You own exactly one task.`);
  lines.push('', '# Delegation contract', `Task: ${c.title}`, `Objective: ${c.objective}`);
  lines.push('', 'Acceptance criteria (each is verified independently; a claim is not a verification):');
  for (const a of c.acceptance_criteria) lines.push(`- [${a.criterion_id}] ${a.description} (${a.mandatory ? 'mandatory' : 'optional'}; verified by ${a.verification_kind})`);
  if (c.required_outputs.length) {
    lines.push('', 'Required outputs:');
    for (const o of c.required_outputs) lines.push(`- ${o.key} (${o.kind}): ${o.description}`);
  }
  lines.push('', `Write scope (relative to the current directory): ${c.authority.write_scope.join(', ') || 'none'}`);
  lines.push(`You may not: ${c.authority.forbidden_actions.join(', ')}. Anything outward-facing is drafted for a human, never sent.`);
  if (c.resources.stopping_conditions.length) lines.push(`Stop when: ${c.resources.stopping_conditions.join('; ')}`);
  const keys = Object.keys(req.inputs);
  if (keys.length) {
    lines.push('', '# Inputs (exact pinned versions)');
    for (const k of keys) {
      const pin = c.inputs.find((i) => i.artifact_key === k);
      lines.push(`## ${k}${pin ? ` — version ${pin.version_id}, sha256 ${pin.content_hash.slice(0, 12)}` : ''}`, req.inputs[k]!, '');
    }
  }
  if (Object.keys(req.params).length) lines.push('', '# Parameters', JSON.stringify(req.params, null, 2));
  lines.push(
    '',
    '# How to answer',
    'Return the structured result. Put documents in `artifacts[].content` under the required output keys.',
    'For code, return file_changes: [{path, content}] with complete file contents (null to delete). You have no tools. Work from the supplied workspace snapshot. The runtime validates paths, applies edits and runs tests in isolation; report checks you have not run as unknown.',
    'Mark each evidence item as an observed fact or an interpretation. List what remains uncertain. Do not claim a criterion is met unless you say what you ran or checked.',
  );
  return lines.join('\n');
}

/**
 * LIVE PROVIDER — real model execution through the installed Claude Code CLI in headless mode.
 * One OS process per attempt. Off unless the operator enables live execution; a capacity error
 * is reported as `rate_limited` and never triggers a fallback.
 */
export class ClaudeCliProvider implements Provider {
  name = 'claude-cli';
  mode = 'live' as const;
  guarantees =
    'Real model execution. At-most-one accepted result per fencing token; a retried attempt reruns the model (outputs are stochastic and are not replayed). Usage is provider-reported; cost is a list-price estimate, not billing.';
  private limits: LimitsProfile;
  private scratch: string;
  private blockedUntil = 0;
  private blockedReason: string | null = null;

  constructor(limits: LimitsProfile, scratch: string) {
    this.limits = limits;
    this.scratch = scratch;
  }

  available(): { ok: boolean; reason: string | null } {
    if (!this.limits.live_execution_enabled) return { ok: false, reason: 'live execution is disabled by operator configuration (set SWARM2_LIVE=1 to enable)' };
    if (Date.now() < this.blockedUntil) return { ok: false, reason: this.blockedReason };
    return { ok: true, reason: null };
  }

  /** Stop dispatching for a while after a capacity error instead of spinning. */
  noteRateLimit(message: string, backoffMs = 5 * 60_000): void {
    this.blockedUntil = Date.now() + backoffMs;
    this.blockedReason = `provider capacity exhausted: ${message}`;
  }

  start(req: WorkRequest, hooks: ProviderHooks): WorkerHandle {
    const gate = this.available();
    if (!gate.ok) {
      const result: WorkResult = { status: 'rate_limited', output: null, self_submitted: false, usage: null, model_requested: req.model, model_actual: null, session_id: null, error: { code: 'provider_unavailable', message: gate.reason ?? 'unavailable' } };
      return { pid: null, done: Promise.resolve(result), kill: () => undefined };
    }
    const cwd = join(this.scratch, req.attempt_id);
    mkdirSync(cwd, { recursive: true });
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(WORK_OUTPUT_SCHEMA), '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', ''];
    if (req.instructions) args.push('--append-system-prompt', req.instructions);
    if (req.model) args.push('--model', req.model);
    if (req.effort) args.push('--effort', req.effort);
    if (req.max_budget_usd !== null) args.push('--max-budget-usd', String(req.max_budget_usd));
    args.push('--tools', '');
    const started = Date.now();
    const child = spawn('claude', args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    child.stdin.on('error', () => undefined);
    child.stdin.end(buildPrompt(req));
    let buffer = '';
    let bytes = 0;
    let final: ClaudeResultEvent | null = null;
    let lastBeat = 0;
    let timed_out = false;
    const timer = setTimeout(() => {
      timed_out = true;
      killGroup(child);
    }, req.timeout_ms);
    // A model can generate for longer than a lease without emitting an event. While the process is
    // alive the lease is kept; a worker that hangs is ended by the timeout above.
    const beat = setInterval(() => {
      if (Date.now() - lastBeat > 1000) {
        lastBeat = Date.now();
        hooks.onHeartbeat({ pid: child.pid });
      }
    }, Math.max(500, Math.floor(this.limits.lease_ms / 5)));
    child.stdout.on('data', (d: Buffer) => {
      bytes += d.length;
      if (bytes > 2 * 1024 * 1024) { killGroup(child); return; }
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as ClaudeResultEvent;
          if (ev.type === 'result') final = ev;
          if (Date.now() - lastBeat > 1000) {
            lastBeat = Date.now();
            hooks.onHeartbeat({ pid: child.pid, ...(ev.session_id ? { session_id: ev.session_id } : {}) });
          }
        } catch {
          /* partial or non-JSON line */
        }
      }
    });
    child.stderr.on('data', () => undefined);
    const done = new Promise<WorkResult>((resolve) => {
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        clearInterval(beat);
        const result = interpretResult(final, { model_requested: req.model, wall_ms: Date.now() - started, exit_code: code, signal, timed_out, expects_structured: true });
        if (result.status === 'rate_limited') this.noteRateLimit(result.error?.message ?? '');
        resolve(result);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        clearInterval(beat);
        resolve({ status: 'failed', output: null, self_submitted: false, usage: null, model_requested: req.model, model_actual: null, session_id: null, error: { code: 'spawn_failed', message: String(err) } });
      });
    });
    return { pid: child.pid ?? null, done, kill: (signal = 'SIGTERM') => killGroup(child, signal) };
  }
}
