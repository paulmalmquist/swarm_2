import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from '../config.ts';
import { tokenString } from '../kernel/kernel.ts';
import type { Provider, ProviderHooks, WorkRequest, WorkResult, WorkerHandle } from './provider.ts';

/**
 * DETERMINISTIC FIXTURE PROVIDER — not a model.
 *
 * Each attempt is still a real, separate operating-system process: it holds a lease, heartbeats,
 * writes real files into its worktree and submits through the same fenced path a model worker uses.
 * What is scripted is the *content* of the work, which comes from the scenario's behaviors.
 * Everything it produces is labeled `fixture`.
 */
export class FixtureProvider implements Provider {
  name = 'fixture';
  mode = 'fixture' as const;
  guarantees = 'Deterministic scripted work in a real child process. Results are submitted by the worker itself under its fencing token.';

  available(): { ok: boolean; reason: string | null } {
    return { ok: true, reason: null };
  }

  start(req: WorkRequest, hooks: ProviderHooks): WorkerHandle {
    const args = [
      '--disable-warning=ExperimentalWarning',
      join(REPO_ROOT, 'src', 'providers', 'fixture-worker.ts'),
      '--db', req.db_path,
      '--artifacts', req.artifact_dir,
      '--task', req.task.id,
      '--token', tokenString(req.token),
      '--scenario', req.mission.scenario ?? 'generic',
      '--workspace', req.workspace?.dir ?? '',
      '--branch', req.workspace?.branch ?? '',
      '--base', req.workspace?.base_commit ?? '',
      '--faults', req.faults.join(','),
      '--lease-ms', String(req.lease_ms),
    ];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SWARM2_FIXTURE_WORKER: '1' } });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.stdout.on('data', () => hooks.onHeartbeat({ pid: child.pid }));
    if (child.pid) hooks.onHeartbeat({ pid: child.pid });
    const timer = setTimeout(() => child.kill('SIGKILL'), req.timeout_ms);
    const done = new Promise<WorkResult>((resolve) => {
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const base = { output: null, usage: null, model_requested: null, model_actual: null, session_id: null };
        if (code === 0) resolve({ ...base, status: 'ok', self_submitted: true, error: null });
        else if (signal) resolve({ ...base, status: 'killed', self_submitted: false, error: { code: 'worker_killed', message: `fixture worker terminated by ${signal}` } });
        else resolve({ ...base, status: 'failed', self_submitted: false, error: { code: 'worker_exit', message: `fixture worker exited ${code}: ${stderr.trim().slice(-300)}` } });
      });
    });
    return { pid: child.pid ?? null, done, kill: (signal = 'SIGTERM') => void child.kill(signal) };
  }
}
