import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SwarmError } from '../lib/util.ts';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timed_out: boolean;
}

const GIT_ID = ['-c', 'user.name=swarm2', '-c', 'user.email=swarm2@localhost', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];

/**
 * Isolated workspaces for concurrent coding workers.
 *
 * Every mission gets its own throwaway git repository seeded from a fixture application.
 * Every coding attempt gets its own worktree and branch; nothing shares a working directory.
 * Integration happens in a separate worktree, one merge at a time.
 */
export class Workspaces {
  root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  repoDir(mission_id: string): string {
    return join(this.root, mission_id, 'repo');
  }

  integrationDir(mission_id: string): string {
    return join(this.root, mission_id, 'integration');
  }

  git(cwd: string, args: string[], allowFail = false): string {
    const r = spawnSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0 && !allowFail) {
      throw new SwarmError('git_failed', `git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`, { cwd });
    }
    return (r.stdout ?? '').trim();
  }

  /** Create the mission repository from a seed directory. Safe to call again after a restart. */
  initMissionRepo(mission_id: string, seedDir: string): { repo: string; base_commit: string } {
    const repo = this.repoDir(mission_id);
    if (existsSync(join(repo, '.git'))) return { repo, base_commit: this.git(repo, ['rev-list', '--max-parents=0', 'HEAD']) };
    mkdirSync(repo, { recursive: true });
    cpSync(seedDir, repo, { recursive: true });
    this.git(repo, ['init', '-q']);
    this.git(repo, ['add', '-A']);
    this.git(repo, ['commit', '-q', '-m', 'Seed fixture application']);
    const base = this.git(repo, ['rev-parse', 'HEAD']);
    this.git(repo, ['branch', 'integration']);
    this.git(repo, ['worktree', 'add', '-q', this.integrationDir(mission_id), 'integration']);
    return { repo, base_commit: base };
  }

  /** A fresh worktree and branch for one attempt, based on the current integration head. */
  createWorktree(mission_id: string, taskKey: string, attemptNo: number, generation: number): { dir: string; branch: string; base_commit: string } {
    const repo = this.repoDir(mission_id);
    const safe = taskKey.replace(/[^a-zA-Z0-9_-]+/g, '-');
    const branch = `task/${safe}/g${generation}a${attemptNo}`;
    const dir = join(this.root, mission_id, 'wt', `${safe}-g${generation}a${attemptNo}`);
    if (existsSync(dir)) {
      this.git(repo, ['worktree', 'remove', '--force', dir], true);
      rmSync(dir, { recursive: true, force: true });
    }
    this.git(repo, ['branch', '-D', branch], true);
    mkdirSync(dirname(dir), { recursive: true });
    this.git(repo, ['worktree', 'add', '-q', '-b', branch, dir, 'integration']);
    return { dir, branch, base_commit: this.git(dir, ['rev-parse', 'HEAD']) };
  }

  /** Write pinned inputs into the worktree so the worker builds against exact versions. */
  materializeInputs(dir: string, inputs: { path: string; content: string }[]): void {
    for (const i of inputs) {
      const p = join(dir, i.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, i.content);
    }
  }

  /** Commit everything in a worktree. Returns null when there is nothing to commit. */
  commitAll(dir: string, message: string): { commit: string; tree: string; files: string[] } | null {
    this.git(dir, ['add', '-A']);
    const staged = this.git(dir, ['diff', '--cached', '--name-only']);
    if (!staged) return null;
    this.git(dir, ['commit', '-q', '-m', message]);
    return { commit: this.git(dir, ['rev-parse', 'HEAD']), tree: this.git(dir, ['rev-parse', 'HEAD^{tree}']), files: staged.split('\n') };
  }

  head(dir: string): { commit: string; tree: string } {
    return { commit: this.git(dir, ['rev-parse', 'HEAD']), tree: this.git(dir, ['rev-parse', 'HEAD^{tree}']) };
  }

  changedFiles(dir: string, base: string, head = 'HEAD'): { path: string; status: string }[] {
    const out = this.git(dir, ['diff', '--name-status', base, head]);
    return out
      ? out.split('\n').map((l) => {
          const [status, ...rest] = l.split('\t');
          return { status: status ?? '?', path: rest.join('\t') };
        })
      : [];
  }

  /**
   * Merge one branch into the integration worktree. A conflict is aborted and reported;
   * the integration branch is left exactly where it was.
   */
  merge(mission_id: string, branch: string, message: string): { ok: boolean; conflict: boolean; pre: string; post: string; detail: string } {
    const dir = this.integrationDir(mission_id);
    this.recoverIntegration(mission_id);
    const pre = this.git(dir, ['rev-parse', 'HEAD']);
    const r = spawnSync('git', [...GIT_ID, 'merge', '--no-ff', '-m', message, branch], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) {
      this.git(dir, ['merge', '--abort'], true);
      this.git(dir, ['reset', '-q', '--hard', pre]);
      return { ok: false, conflict: true, pre, post: pre, detail: (r.stdout + r.stderr).trim().slice(0, 600) };
    }
    return { ok: true, conflict: false, pre, post: this.git(dir, ['rev-parse', 'HEAD']), detail: '' };
  }

  /** Put the integration worktree back to a known commit (used when the combined result fails). */
  resetIntegration(mission_id: string, commit: string): void {
    const dir = this.integrationDir(mission_id);
    this.git(dir, ['merge', '--abort'], true);
    this.git(dir, ['reset', '-q', '--hard', commit]);
    this.git(dir, ['clean', '-fdq']);
  }

  /** After a crash mid-merge: abort any half-finished merge and drop stray files. */
  recoverIntegration(mission_id: string): void {
    const dir = this.integrationDir(mission_id);
    if (!existsSync(dir)) return;
    this.git(dir, ['merge', '--abort'], true);
    this.git(dir, ['reset', '-q', '--hard', 'HEAD']);
    this.git(dir, ['clean', '-fdq']);
  }

  /** A clean checkout of a commit for independent verification. */
  checkoutForVerification(mission_id: string, commit: string, name: string): string {
    const repo = this.repoDir(mission_id);
    const dir = join(this.root, mission_id, 'verify', name);
    if (existsSync(dir)) {
      this.git(repo, ['worktree', 'remove', '--force', dir], true);
      rmSync(dir, { recursive: true, force: true });
    }
    mkdirSync(dirname(dir), { recursive: true });
    this.git(repo, ['worktree', 'add', '-q', '--detach', dir, commit]);
    return dir;
  }

  run(cwd: string, cmd: string[], timeoutMs = 60_000, env: Record<string, string> = {}): Promise<RunResult> {
    return new Promise((resolve) => {
      const started = Date.now();
      // A check must behave the same whether or not this process is itself running under a test runner.
      const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
      delete childEnv.NODE_TEST_CONTEXT;
      const child = spawn(cmd[0]!, cmd.slice(1), { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timed_out = false;
      const timer = setTimeout(() => {
        timed_out = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, ms: Date.now() - started, timed_out });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + String(err), ms: Date.now() - started, timed_out });
      });
    });
  }
}

/** Parse top-level results from the Node test runner's TAP output. */
export function parseTap(out: string): { name: string; ok: boolean }[] {
  const results: { name: string; ok: boolean }[] = [];
  for (const line of out.split('\n')) {
    const m = /^(not ok|ok) \d+ - (.*)$/.exec(line);
    if (m) results.push({ ok: m[1] === 'ok', name: (m[2] ?? '').replace(/ # .*$/, '').trim() });
  }
  return results;
}
