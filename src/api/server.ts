import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { join } from 'node:path';
import { REPO_ROOT } from '../config.ts';
import type { Command } from '../contracts/types.ts';
import { Coordinator } from '../coordination/coordinator.ts';
import { LocalChiefOfStaff, type RawRequest, type SubmitMission } from '../cos/port.ts';
import { installArena } from '../evolution/arena.ts';
import { renderReceipt } from '../evolution/receipts.ts';
import { Gate } from '../gate/gate.ts';
import { openRuntime } from '../runtime.ts';
import { SwarmError } from '../lib/util.ts';
import * as views from './views.ts';

/** Route registry, in the shape Paul OS uses for its surfaces (`/v1/os/...`). */
export const BASE = '/v1/os/swarm';
export const swarmApiRoutes = {
  overview: `${BASE}/overview`,
  planning: `${BASE}/planning`,
  doing: `${BASE}/doing`,
  ownership: `${BASE}/ownership`,
  reviewing: `${BASE}/reviewing`,
  evolution: `${BASE}/evolution`,
  metrics: `${BASE}/metrics`,
  mission: (id: string) => `${BASE}/missions/${encodeURIComponent(id)}`,
  task: (id: string) => `${BASE}/tasks/${encodeURIComponent(id)}`,
  artifact: (id: string) => `${BASE}/artifacts/${encodeURIComponent(id)}`,
  receipt: (id: string) => `${BASE}/receipts/${encodeURIComponent(id)}`,
  events: `${BASE}/events`,
  commands: `${BASE}/commands`,
} as const;

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(text);
}

function problem(res: ServerResponse, status: number, code: string, detail: string, extra: Record<string, unknown> = {}): void {
  send(res, status, { type: `urn:swarm2:problem:${code}`, title: code.replace(/_/g, ' '), status, code, detail, ...extra }, 'application/problem+json; charset=utf-8');
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new SwarmError('too_large', 'request body is too large');
  }
  return raw ? JSON.parse(raw) : {};
}

/**
 * The review interface and its API. It reads the same durable store the coordinator writes.
 * It binds to loopback, checks a per-process token on every mutation, and is not an
 * authenticated shared service: do not expose it through a proxy or tunnel.
 */
export async function serve(opts: { home?: string; port: number; host?: string; run?: boolean; quiet?: boolean }): Promise<{ port: number; token: string; close(): Promise<void> }> {
  const rt = openRuntime({ home: opts.home });
  const gate = new Gate(rt);
  gate.init();
  installArena(gate);
  const cos = new LocalChiefOfStaff(rt, (m) => gate.releaseFor(m));
  cos.onPinned = (c, m) => gate.noteCanaryMission(c, m);
  const token = randomBytes(18).toString('hex');
  const uiDir = join(REPO_ROOT, 'src', 'ui');
  const co = opts.run ? new Coordinator(rt, { log: (m) => process.stderr.write(`[coordinator] ${m}\n`) }) : null;
  let loop: NodeJS.Timeout | null = null;
  let tickPromise: Promise<unknown> | null = null;
  if (co) {
    co.recover();
    let ticking = false;
    loop = setInterval(() => {
      if (co.stopRequested()) { co.stop(); return; }
      if (ticking) return;
      ticking = true;
      tickPromise = co.tick()
        .catch((err) => process.stderr.write(`[coordinator] ${String(err)}\n`))
        .finally(() => (ticking = false));
    }, 150);
  }

  const command = (body: Command<Record<string, unknown>>): unknown => {
    const c = { ...body, actor: body.actor || 'paul' };
    if (!c.key || typeof c.key !== 'string') throw new SwarmError('missing_idempotency_key', 'every command needs an idempotency key');
    switch (c.command) {
      case 'ingestRequests':
        return cos.ingestRequests(c as unknown as Command<{ requests: RawRequest[] }>);
      case 'submitMission':
        return cos.submitMission(c as unknown as Command<SubmitMission>);
      case 'changePriority':
        return cos.changePriority(c as unknown as Command<{ mission_id: string; priority: number }>);
      case 'cancelMission': {
        const r = cos.cancelMission(c as unknown as Command<{ mission_id: string; reason: string }>);
        if (r.source !== 'unavailable') for (const pid of r.pids_to_stop) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        return r;
      }
      case 'resolveDecision':
        return cos.resolveDecision(c as unknown as Command<{ decision_id: string; chosen: string; rationale: string }>);
      case 'reviewDraft':
        return cos.reviewDraft(c as unknown as Command<{ draft_id: string; approve: boolean; note: string }>);
      case 'recordCorrection':
        return cos.recordCorrection(c as unknown as Command<{ mission_id: string; task_key: string | null; correction: string; failure_class: string }>);
      default:
        throw new SwarmError('unknown_command', `unknown command ${String(c.command)}`);
    }
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;
        if (req.method === 'POST' && path === swarmApiRoutes.commands) {
          if (req.headers['x-swarm2-token'] !== token) return problem(res, 403, 'bad_token', 'this request did not come from the review interface served by this process');
          return send(res, 200, command((await readJson(req)) as Command<Record<string, unknown>>));
        }
        if (req.method !== 'GET') return problem(res, 405, 'method_not_allowed', 'only GET and POST /commands are supported');
        if (path === swarmApiRoutes.overview) {
          const o = views.overview(rt, gate);
          if (o.source !== 'unavailable') (o as Record<string, unknown>).stopped = existsSync(join(rt.paths.home, 'STOP'));
          return send(res, 200, o);
        }
        if (path === swarmApiRoutes.planning) return send(res, 200, views.planning(rt));
        if (path === swarmApiRoutes.doing) return send(res, 200, views.doing(rt));
        if (path === swarmApiRoutes.ownership) return send(res, 200, views.ownership(rt, url.searchParams.get('mission') ?? undefined));
        if (path === swarmApiRoutes.reviewing) return send(res, 200, views.reviewing(rt));
        if (path === swarmApiRoutes.evolution) return send(res, 200, views.evolution(rt, gate));
        if (path === swarmApiRoutes.metrics) return send(res, 200, views.metrics(rt, gate));
        if (path === swarmApiRoutes.events) return send(res, 200, { source: 'fixture', generated_at: rt.store.clock.iso(), events: rt.store.events({ after_seq: Number(url.searchParams.get('after') ?? 0), mission_id: url.searchParams.get('mission') ?? undefined, limit: 500 }) });
        const m = /^\/v1\/os\/swarm\/(missions|tasks|artifacts|receipts)\/([^/]+)$/.exec(path);
        if (m) {
          const id = decodeURIComponent(m[2]!);
          if (m[1] === 'missions') return send(res, 200, views.missionDetail(rt, id));
          if (m[1] === 'tasks') return send(res, 200, views.taskDetail(rt, id));
          if (m[1] === 'artifacts') return send(res, 200, views.artifactContent(rt, id));
          const r = views.receipt(gate, id);
          if (url.searchParams.get('format') === 'md' && r.source !== 'unavailable') return send(res, 200, renderReceipt(r.receipt), 'text/markdown; charset=utf-8');
          return send(res, 200, r);
        }
        const file = path === '/' ? 'index.html' : path.slice(1);
        if (/^[a-z0-9_.-]+$/i.test(file) && existsSync(join(uiDir, file))) {
          const ext = file.slice(file.lastIndexOf('.'));
          let text = readFileSync(join(uiDir, file), 'utf8');
          if (file === 'index.html') text = text.replace('__SWARM2_TOKEN__', token);
          return send(res, 200, text, TYPES[ext] ?? 'text/plain; charset=utf-8');
        }
        return problem(res, 404, 'not_found', `no route ${path}`);
      } catch (err) {
        if (err instanceof SwarmError) return problem(res, ['idempotency_conflict', 'stale_revision'].includes(err.code) ? 409 : 400, err.code, err.message, { details: err.details });
        return problem(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  if (!opts.quiet) process.stdout.write(`swarm2 review interface: http://${opts.host ?? '127.0.0.1'}:${port}/  (state: ${rt.paths.home}${co ? '; coordinator running in this process' : '; read-only unless a coordinator is running'})\n`);
  return {
    port,
    token,
    close: async () => {
      if (loop) clearInterval(loop);
      co?.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await tickPromise;
      await co?.drain();
      gate.close();
      rt.close();
    },
  };
}
