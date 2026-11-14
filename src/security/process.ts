import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { SwarmError } from '../lib/util.ts';

// No fallback to host execution. The network namespace is created by unshare rather than
// bubblewrap so hosts that forbid netlink configuration can still enforce network isolation.
const node = realpathSync(process.execPath);
const env = { PATH: '/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', NODE_NO_WARNINGS: '1' };

function command(read: string[], cwd: string, args: string[]): string[] {
  const mounts = [...new Set(['/usr', '/lib', '/lib64'].filter(existsSync))].flatMap((p) => ['--ro-bind', p, p]);
  if (!node.startsWith('/usr/')) mounts.push('--ro-bind', node, node);
  for (const p of [...new Set(read.map((p) => realpathSync(p)))]) mounts.push('--ro-bind', p, p);
  return ['--user', '--map-root-user', '--net', 'bwrap', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--die-with-parent', '--cap-drop', 'ALL', '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', ...mounts, '--clearenv', '--setenv', 'HOME', '/tmp', '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'NODE_NO_WARNINGS', '1', '--chdir', resolve(cwd),
    'prlimit', '--cpu=60', '--nofile=256', '--nproc=128', '--', node, '--max-old-space-size=256', ...args];
}

let capability: { ok: boolean; reason: string } | undefined;
export function isolationCapability(): { ok: boolean; reason: string } {
  if (capability) return capability;
  if (process.platform !== 'linux') return capability = { ok: false, reason: 'Linux user, mount, PID and network namespaces are required' };
  const r = spawnSync('unshare', command([], '/', ['-e', '0']), { env, encoding: 'utf8', timeout: 5000 });
  return capability = { ok: r.status === 0, reason: r.status === 0 ? 'Linux namespace isolation' : String(r.error ?? r.stderr ?? 'namespace sandbox unavailable').trim().slice(0, 300) };
}

export function killGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}

/** Only explicit read mounts, an ephemeral /tmp, no host environment or network. */
export function isolatedNode(read: string[], cwd: string, args: string[], stdin: 'pipe' | 'ignore' = 'ignore'): ChildProcess {
  const cap = isolationCapability();
  if (!cap.ok) throw new SwarmError('isolation_unavailable', `Refusing candidate code: ${cap.reason}`);
  return spawn('unshare', command(read, cwd, args), { env, detached: true, stdio: [stdin, 'pipe', 'pipe'] });
}
