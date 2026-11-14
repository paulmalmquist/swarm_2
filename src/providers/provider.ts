import type { Mission, ProviderMode, Task, UsageRecord, WorkOutput } from '../contracts/types.ts';
import type { Token } from '../kernel/kernel.ts';

export interface WorkRequest {
  attempt_id: string;
  task: Task;
  mission: Mission;
  token: Token;
  workspace: { dir: string; branch: string | null; base_commit: string | null } | null;
  /** Pinned inputs, by artifact key. */
  inputs: Record<string, string>;
  params: Record<string, unknown>;
  /** Role instructions and skill text from the mission's pinned release. */
  instructions: string;
  model: string | null;
  effort: string | null;
  timeout_ms: number;
  max_budget_usd: number | null;
  /** Labeled injected faults for this attempt (resilience demonstrations only). */
  faults: string[];
  db_path: string;
  artifact_dir: string;
  lease_ms: number;
}

export interface WorkResult {
  status: 'ok' | 'failed' | 'rate_limited' | 'timeout' | 'killed' | 'invalid_output';
  /** Null when the worker already wrote its result to the store itself. */
  output: WorkOutput | null;
  self_submitted: boolean;
  usage: UsageRecord | null;
  model_requested: string | null;
  model_actual: string | null;
  session_id: string | null;
  error: { code: string; message: string } | null;
  /** Tool uses the worker harness refused (for example a read outside the workspace). An audit trail, when the provider reports one. */
  denials?: { tool: string; target: string }[];
}

export interface WorkerHandle {
  pid: number | null;
  done: Promise<WorkResult>;
  kill(signal?: NodeJS.Signals): void;
}

export interface ProviderHooks {
  /** Called whenever the worker shows signs of life. */
  onHeartbeat(info: { pid?: number; session_id?: string }): void;
}

/**
 * The adapter boundary between the durable task model and whatever actually runs a worker.
 * `mode` is part of every record a provider produces, so live execution and labeled fixtures
 * can never be confused downstream.
 */
export interface Provider {
  name: string;
  mode: ProviderMode;
  /** Whether work can be dispatched right now, and if not, why. */
  available(): { ok: boolean; reason: string | null };
  start(req: WorkRequest, hooks: ProviderHooks): WorkerHandle;
  /** What this adapter actually guarantees. */
  guarantees: string;
}
