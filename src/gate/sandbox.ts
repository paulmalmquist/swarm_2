import { type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../config.ts';
import type { IsolationCapability } from '../contracts/runtime.ts';
import { isolatedNode, isolationCapability, killGroup } from '../security/process.ts';
import { SwarmError } from '../lib/util.ts';

export const CANDIDATE_UID = Number(process.env.SWARM2_CANDIDATE_UID ?? 65534);
const RUNNER = join(REPO_ROOT, 'src', 'gate', 'sandbox', 'run-candidate.mjs');

let cached: IsolationCapability | null = null;

/**
 * Find out what separation this host can actually enforce between candidate code and the
 * release gate, by trying it. The answer is stamped on every improvement receipt.
 */
export function detectIsolation(): IsolationCapability {
  if (cached) return cached;
  const cap = isolationCapability();
  cached = { uid_separation: false, candidate_uid: null, node_permission_model: true, mode: cap.ok ? 'enforced' : 'procedural', notes: [cap.reason, 'Execution fails closed without namespace isolation; filesystem read mounts only, no network or inherited environment.'] };
  return cached;
}

/** A running sandboxed process that executes candidate code on request. */
export class CandidateProcess {
  private child: ChildProcess;
  private buffer = '';
  private waiting = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  stderr = '';
  exited = false;

  constructor(bundleDir: string, extra: { allowRead?: string[]; allowWrite?: string[]; iso?: IsolationCapability } = {}) {
    const iso = extra.iso ?? detectIsolation();
    const nodeArgs: string[] = [];
    if (iso.node_permission_model) {
      nodeArgs.push('--permission', `--allow-fs-read=${RUNNER}`, `--allow-fs-read=${bundleDir}`);
      for (const r of extra.allowRead ?? []) nodeArgs.push(`--allow-fs-read=${r}`);
      for (const w of extra.allowWrite ?? []) nodeArgs.push(`--allow-fs-write=${w}`);
    }
    nodeArgs.push(RUNNER);
    if (extra.allowWrite?.length) throw new SwarmError('sandbox_write_denied', 'Candidate bundles are read-only');
    this.child = isolatedNode([RUNNER, bundleDir, ...(extra.allowRead ?? [])], '/', nodeArgs, 'pipe');
    this.child.stdout!.on('data', (d: Buffer) => {
      if (this.buffer.length + d.length > 1024 * 1024) { killGroup(this.child); return; }
      this.buffer += d.toString();
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        try {
          const msg = JSON.parse(line) as { id: number } & Record<string, unknown>;
          const w = this.waiting.get(msg.id);
          if (w) {
            clearTimeout(w.timer);
            this.waiting.delete(msg.id);
            w.resolve(msg);
          }
        } catch {
          /* candidate code may print noise; it is ignored */
        }
      }
    });
    this.child.stderr!.on('data', (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-4000)));
    this.child.on('close', () => {
      this.exited = true;
      for (const [, w] of this.waiting) {
        clearTimeout(w.timer);
        w.reject(new SwarmError('candidate_exited', `candidate process exited: ${this.stderr.trim().slice(-300)}`));
      }
      this.waiting.clear();
    });
    this.child.on('error', (err) => { this.stderr = String(err); this.exited = true; for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(err); } this.waiting.clear(); });
    this.child.stdin!.on('error', () => undefined);
  }

  request(op: string, body: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    if (this.exited) return Promise.reject(new SwarmError('candidate_exited', `candidate process is not running: ${this.stderr.trim().slice(-300)}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        killGroup(this.child);
        reject(new SwarmError('candidate_timeout', `candidate did not answer ${op} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.child.stdin!.write(JSON.stringify({ id, op, ...body }) + '\n');
    });
  }

  close(): void {
    try {
      this.child.stdin!.end();
    } catch {
      /* already closed */
    }
    setTimeout(() => killGroup(this.child), 500).unref();
  }
}
