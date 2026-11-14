import type { SkillDefinition, SwarmArchetype } from './types.ts';

/**
 * Versioned definitions. Each level is a separate component with its own version history,
 * so an execution change, a coordination change and a change to the improvement process
 * can each be a candidate on its own.
 */

export interface Route {
  model: string;
  effort: string | null;
}

/** Level 1 — how individual work is executed. */
export interface ExecutionDef {
  level: 'execution';
  version: number;
  summary: string;
  routing: { default: Route; by_archetype: Partial<Record<SwarmArchetype, Route>>; by_role: Record<string, Route> };
  retry: { max_retries_per_task: number; max_repair_attempts: number };
  context: { max_memories: number; include_failed_approaches: boolean; max_input_chars: number };
  agents: Record<SwarmArchetype, { instructions: string }>;
  skills: Record<string, SkillDefinition>;
}

/** Level 2 — how work is divided, handed off, reviewed and integrated. */
export interface CoordinationDef {
  level: 'coordination';
  version: number;
  summary: string;
  archetypes: Record<SwarmArchetype, { responsibility: string; activate_when: string; default_roles: string[] }>;
  decomposition: {
    /** Agree the shared interface as a pinned artifact before parallel implementation starts. */
    interface_agreement_before_parallel: boolean;
    max_parallel_workstreams: number;
    /** Below this many leaf tasks a single agent is preferred over a swarm. */
    single_agent_below_tasks: number;
  };
  handoff_requirements: string[];
  reviewer_assignment: { independent_verification: boolean };
  integration: { order: 'declared' | 'producer_first'; verify_each_merge: boolean };
  escalation: { max_decision_rounds: number };
  reuse: { enabled: boolean; max_age_ms: number };
  /** Share of the relevant budget class given to each top-level swarm. */
  budget_shares: Record<string, number>;
}

/** Level 3 — how the organization finds, prioritizes and stops improvement work. */
export interface EvolutionDef {
  level: 'evolution';
  version: number;
  summary: string;
  /** File inside the bundle that exports the improvement policy. */
  policy_module: string;
  params: Record<string, number>;
  problem_finding: string;
  hypothesis_generation: string;
  prioritization: string;
  exploration_budget: string;
  stopping: string;
  generalization_check: string;
}
