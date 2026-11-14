import type { BudgetClass, Iso, ResourceAmounts, SourceLabel } from './types.ts';

/** A node in the hierarchical budget tree. Children are carved out of their parent, never added to it. */
export interface BudgetAccount {
  id: string;
  parent_id: string | null;
  mission_id: string | null;
  owner_ref: string;
  class: BudgetClass;
  limit: ResourceAmounts;
  /** Consumption recorded directly on this account. */
  consumed: ResourceAmounts;
  status: 'open' | 'closed';
  created_at: Iso;
  closed_at: Iso | null;
}

export interface IntegrationItem {
  id: string;
  mission_id: string;
  /** The delivery task whose branch is being integrated. */
  task_id: string;
  /** The integration task that owns the queue. */
  integrator_task_id: string;
  attempt_no: number;
  generation: number;
  branch: string;
  position: number;
  status: 'queued' | 'merging' | 'verifying' | 'merged' | 'rejected' | 'conflict' | 'superseded';
  pre_merge_commit: string | null;
  merge_commit: string | null;
  result: { ok: boolean; summary: string; evidence_id: string | null } | null;
  created_at: Iso;
  updated_at: Iso;
}

/**
 * An effect outside the transactional store. Guarantee: at-least-once intent with idempotent
 * reconciliation — never exactly-once across systems. An `unknown` outcome is reconciled
 * against the target before any retry.
 */
export interface ExternalEffect {
  id: string;
  adapter: string;
  action: string;
  idempotency_key: string;
  status: 'intended' | 'confirmed' | 'failed' | 'unknown';
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
  attempts: number;
  created_at: Iso;
  reconciled_at: Iso | null;
}

export interface IsolationCapability {
  uid_separation: boolean;
  candidate_uid: number | null;
  node_permission_model: boolean;
  mode: 'enforced' | 'seatbelt' | 'procedural';
  notes: string[];
}

export interface CapabilityRow {
  capability: string;
  verified: boolean;
  evidence: string;
  limitation: string;
  chosen: string;
  source: SourceLabel;
}
