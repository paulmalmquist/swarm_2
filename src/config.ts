import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthorityEnvelope, LimitsProfile, ResourceAmounts } from './contracts/types.ts';
import { OUTWARD_ACTIONS } from './contracts/types.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Development profile: 12 concurrent model calls and three delegated layers.
 * Every limit here is operator configuration — agents cannot raise their own ceilings.
 */
export const DEV_PROFILE: LimitsProfile = {
  name: 'development',
  max_concurrent_model_calls: 12,
  max_delegation_depth: 3,
  max_worker_invocations: 200,
  max_wall_ms: 60 * 60 * 1000,
  max_tokens: null,
  max_cost_usd_est: null,
  max_retries_per_task: 2,
  max_repair_attempts: 2,
  exploration_share: 0.1,
  reserve: { verification: 0.15, recovery: 0.1, completion: 0.05 },
  lease_ms: 15_000,
  heartbeat_ms: 2_000,
  live_attempt_floor_ms: 5 * 60 * 1000,
  live_execution_enabled: false,
};

export interface Paths {
  home: string;
  db: string;
  artifacts: string;
  workspaces: string;
  candidates: string;
  protected: string;
  gateDb: string;
  evidence: string;
}

export function paths(home = process.env.SWARM2_HOME ?? join(REPO_ROOT, 'var')): Paths {
  const h = resolve(home);
  return {
    home: h,
    db: join(h, 'swarm.db'),
    artifacts: join(h, 'artifacts'),
    workspaces: join(h, 'workspaces'),
    candidates: join(h, 'candidates'),
    protected: join(h, 'protected'),
    gateDb: join(h, 'protected', 'gate.db'),
    evidence: join(h, 'evidence'),
  };
}

/**
 * Operator configuration: `swarm2.config.json` at the repo root, then environment overrides.
 * Live model execution stays off unless the operator turns it on explicitly.
 */
export function loadLimits(overrides: Partial<LimitsProfile> = {}): LimitsProfile {
  let file: Partial<LimitsProfile> = {};
  const p = process.env.SWARM2_CONFIG ?? join(REPO_ROOT, 'swarm2.config.json');
  if (existsSync(p)) file = (JSON.parse(readFileSync(p, 'utf8')) as { limits?: Partial<LimitsProfile> }).limits ?? {};
  const env: Partial<LimitsProfile> = {};
  if (process.env.SWARM2_MAX_CONCURRENT) env.max_concurrent_model_calls = Number(process.env.SWARM2_MAX_CONCURRENT);
  if (process.env.SWARM2_MAX_DEPTH) env.max_delegation_depth = Number(process.env.SWARM2_MAX_DEPTH);
  if (process.env.SWARM2_LEASE_MS) env.lease_ms = Number(process.env.SWARM2_LEASE_MS);
  if (process.env.SWARM2_LIVE === '1') env.live_execution_enabled = true;
  const merged = { ...DEV_PROFILE, ...file, ...env, ...overrides };
  // The development profile is a ceiling for unattended work; the operator may lower it freely.
  merged.max_concurrent_model_calls = Math.max(1, Math.min(merged.max_concurrent_model_calls, 64));
  return merged;
}

/** What a development mission may do on its own: local, reversible work inside its workspace. */
export function devAuthority(): AuthorityEnvelope {
  return {
    tools: ['fs.read', 'fs.write', 'shell.test', 'git.local', 'model.call'],
    data: ['fixture:*', 'workspace:*', 'artifact:*'],
    actions: ['local.reversible', 'artifact.publish', 'decision.propose', 'draft.prepare'],
    write_scope: ['**'],
    forbidden_actions: [...OUTWARD_ACTIONS],
    valid_until: null,
  };
}

export function devBudget(): ResourceAmounts {
  return { model_calls: 120, worker_invocations: 120, tokens: 4_000_000, cost_usd_est: 20, wall_ms: 30 * 60 * 1000 };
}
