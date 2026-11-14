import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../config.ts';
import type { IsolationCapability } from '../contracts/runtime.ts';
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
  const notes: string[] = [];
  let uid_separation = false;
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    const r = spawnSync('setpriv', [`--reuid=${CANDIDATE_UID}`, `--regid=${CANDIDATE_UID}`, '--clear-groups', 'true'], { encoding: 'utf8' });
    uid_separation = r.status === 0;
    if (!uid_separation) notes.push(`setpriv could not drop to uid ${CANDIDATE_UID}: ${(r.stderr ?? '').trim().slice(0, 120) || 'unavailable'}`);
  } else {
    notes.push('not running as root, so candidate code cannot be moved to a separate operating-system user');
  }
  const p = spawnSync(process.execPath, ['--permission', '--allow-fs-read=/nonexistent', '-e', '0'], { encoding: 'utf8' });
  const node_permission_model = p.status === 0;
  if (!node_permission_model) notes.push('this Node build does not support --permission');
  const mode = uid_separation ? 'enforced' : node_permission_model ? 'seatbelt' : 'procedural';
  if (mode === 'enforced') notes.push(`candidate code runs as uid ${CANDIDATE_UID}; the protected store is owned by uid ${process.getuid!()} with mode 0700`);
  if (mode === 'seatbelt') notes.push('only Node\'s permission model separates candidate code from the protected store; Node documents it as a seat belt, not a defence against malicious code');
  if (mode === 'procedural') notes.push('no enforced separation is available: protection is by path checks and digest comparison only');
  cached = { uid_separation, candidate_uid: uid_separation ? CANDIDATE_UID : null, node_permission_model, mode, notes };
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
    const cmd = iso.uid_separation ? 'setpriv' : process.execPath;
    const args = iso.uid_separation ? [`--reuid=${CANDIDATE_UID}`, `--regid=${CANDIDATE_UID}`, '--clear-groups', '--', process.execPath, ...nodeArgs] : nodeArgs;
    // A minimal environment: no credentials, tokens or proxy settings are inherited.
    this.child = spawn(cmd, args, { cwd: '/', env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout!.on('data', (d: Buffer) => {
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
    this.child.stdin!.on('error', () => undefined);
  }

  request(op: string, body: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    if (this.exited) return Promise.reject(new SwarmError('candidate_exited', `candidate process is not running: ${this.stderr.trim().slice(-300)}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        this.child.kill('SIGKILL');
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
    setTimeout(() => this.child.kill('SIGKILL'), 500).unref();
  }
}
