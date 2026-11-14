/**
 * swarm_2 typed contracts — the single source of truth for every durable record.
 *
 * Vocabulary is deliberately aligned with Paul's incumbent systems so records can be
 * exported to them without translation loss:
 *   - provenance envelope (`source: live | … | unavailable` + reason)   ← paulos-surfaces ADR-001
 *   - command envelope `{command, data, actor, key, expected_version}`   ← swarm_receipt command.schema.json
 *   - TaskContract / acceptance criteria / usage completeness           ← swarm-court convergence-governor §8
 *   - artifact currency `current | needs_revalidation | …`, generations  ← swarm-court evidence-invalidation-queue §4–6
 *   - gate kinds HARD_GATE / WEIGHTED, verdicts PASSED / FAILED / …     ← agent-promotion-control-plane
 *   - synthetic identifiers begin with `syn-`                            ← both swarm-court proposals
 *
 * Only erasable TypeScript syntax is used (Node runs these files directly).
 */

// ───────────────────────────── primitives ─────────────────────────────

export type Iso = string; // UTC ISO-8601 timestamp
export type Sha256 = string;

/** Where a value came from. `unavailable` must carry a reason and never becomes a displayed zero. */
export type SourceLabel = 'live' | 'fixture' | 'simulation' | 'replay' | 'unavailable';
export type ProviderMode = 'live' | 'fixture';
export type DataClass = 'synthetic' | 'real';
export type ActorKind = 'human' | 'chief_of_staff' | 'agent' | 'runtime' | 'gate' | 'operator';
export type RiskTier = 'low' | 'medium' | 'high';

/** Mutation envelope shared by every command surface (CLI, HTTP, in-process). */
export interface Command<T> {
  command: string;
  data: T;
  actor: string;
  /** Idempotency key. Same key + same canonical body → original result. Same key + different body → conflict. */
  key: string;
  expected_version?: number | null;
}

export type Envelope<T> =
  | ({ source: Exclude<SourceLabel, 'unavailable'>; generated_at: Iso } & T)
  | { source: 'unavailable'; reason: string };

// ───────────────────────────── organization ─────────────────────────────

export type SwarmArchetype =
  | 'discovery'
  | 'planning'
  | 'delivery'
  | 'verification'
  | 'evolution'
  | 'reliability';

export type Topology = 'single' | 'parallel' | 'hierarchical' | 'competing' | 'temporary_team';

/** Action classes that swarm_2 never executes itself; they are routed to the chief of staff. */
export const OUTWARD_ACTIONS = [
  'external.communication',
  'commitment.new',
  'merge.protected',
  'deploy.shared',
  'authority.change',
] as const;
export type OutwardAction = (typeof OUTWARD_ACTIONS)[number];

/** Bounded authority envelope (Paul OS term). A child's envelope must be a subset of its parent's. */
export interface AuthorityEnvelope {
  tools: string[];
  data: string[];
  actions: string[];
  /** Path globs relative to the task workspace. */
  write_scope: string[];
  forbidden_actions: string[];
  valid_until: Iso | null;
}

export interface ResourceAmounts {
  model_calls: number;
  worker_invocations: number;
  tokens: number;
  cost_usd_est: number;
  wall_ms: number;
}

export type BudgetClass = 'root' | 'delivery' | 'verification' | 'recovery' | 'completion' | 'exploration' | 'task';

export interface LimitsProfile {
  name: string;
  max_concurrent_model_calls: number;
  max_delegation_depth: number;
  max_worker_invocations: number;
  max_wall_ms: number;
  max_tokens: number | null;
  max_cost_usd_est: number | null;
  max_retries_per_task: number;
  max_repair_attempts: number;
  /** Share of a mission budget that evolution experiments may use. */
  exploration_share: number;
  /** Shares held back so delivery cannot exhaust the capacity needed to finish responsibly. */
  reserve: { verification: number; recovery: number; completion: number };
  lease_ms: number;
  heartbeat_ms: number;
  /** Live model execution is off unless the operator turns it on. No automatic fallback between providers. */
  /** A model worker gets at least this long for one attempt, however small its share of the budget. */
  live_attempt_floor_ms: number;
  live_execution_enabled: boolean;
}

// ───────────────────────────── delegation contract ─────────────────────────────

export type VerificationKind = 'executable' | 'inspection' | 'model_judgment' | 'human_review';

export interface AcceptanceCriterion {
  criterion_id: string;
  description: string;
  verification_kind: VerificationKind;
  required_evidence_types: string[];
  mandatory: boolean;
  /** Stakeholder whose distinct need this criterion preserves, if any. */
  stakeholder: string | null;
  /** For executable criteria: the check the verifier runs. */
  check: { runner: string; target: string } | null;
}

export interface InputRef {
  artifact_key: string;
  version_id: string;
  content_hash: Sha256;
  relation: 'uses' | 'derives_from';
}

export interface Assumption {
  id: string;
  statement: string;
  status: 'unverified' | 'supported' | 'refuted' | 'expired';
}

export type ArtifactKind =
  | 'report'
  | 'plan'
  | 'contract'
  | 'code'
  | 'test_result'
  | 'review_packet'
  | 'decision_note'
  | 'draft'
  | 'skill'
  | 'receipt'
  | 'manifest'
  | 'trace';

export type TaskExecutor =
  | 'worker' // a provider-managed worker (model or labeled fixture)
  | 'container' // completes when its children complete (a swarm or team)
  | 'runtime:integrate'
  | 'runtime:verify'
  | 'runtime:review_packet'
  | 'runtime:select'; // evidence-based selection among competing approaches

/** One contract for an individual agent or an entire swarm. */
export interface DelegationContract {
  contract_version: 1;
  mission_id: string;
  task_id: string;
  parent_task_id: string | null;
  assignee: { kind: 'agent' | 'swarm'; archetype: SwarmArchetype; role: string };
  /** Exactly one accountable owner. */
  owner_id: string;
  accountable_human: string;
  title: string;
  objective: string;
  acceptance_criteria: AcceptanceCriterion[];
  inputs: InputRef[];
  dependencies: string[];
  assumptions: Assumption[];
  authority: AuthorityEnvelope;
  resources: { reservation: ResourceAmounts; deadline: Iso | null; stopping_conditions: string[] };
  required_outputs: { key: string; kind: ArtifactKind; description: string }[];
  verification: { method: 'executable' | 'independent_review' | 'both' | 'none'; independent: boolean };
  escalation: { path: string[]; after_ms: number | null };
  cancellation: { propagate: boolean; preserve_artifacts: boolean; grace_ms: number };
  risk_tier: RiskTier;
  release_id: string;
}

// ───────────────────────────── missions and tasks ─────────────────────────────

export type MissionStatus =
  | 'proposed'
  | 'planning'
  | 'active'
  | 'blocked'
  | 'review_ready'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface Mission {
  id: string;
  title: string;
  objective: string;
  status: MissionStatus;
  priority: number; // lower runs first
  requested_by: string;
  accountable_human: string;
  authorization: AuthorityEnvelope;
  budget_account_id: string;
  /** Missions stay pinned to the release chosen at creation. */
  release_id: string;
  data_class: DataClass;
  provider_mode: ProviderMode;
  scenario: string | null;
  request_ids: string[];
  root_task_id: string | null;
  created_at: Iso;
  updated_at: Iso;
  revision: number;
  cancel_reason: string | null;
  migration: { required: boolean; reason: string | null; from_release: string | null } | null;
}

export type TaskStatus =
  | 'planned' // created; prerequisites not yet satisfied
  | 'ready'
  | 'active' // a container whose children are in progress
  | 'leased' // an attempt holds the lease
  | 'submitted' // result in, awaiting verification
  | 'verifying'
  | 'accepted'
  | 'rework' // verification failed; will be re-queued
  | 'blocked' // waiting on a decision, input, or capacity
  | 'failed'
  | 'cancelled'
  | 'not_selected'; // a competing approach that lost an evidence-based selection

export type Currency = 'current' | 'needs_revalidation' | 'lineage_unknown' | 'superseded';

export interface NextAction {
  /** Whose move it is. */
  owner_id: string;
  owner_kind: ActorKind;
  action: string;
  since: Iso;
}

export interface Task {
  id: string;
  mission_id: string;
  parent_task_id: string | null;
  swarm_id: string | null;
  /** Stable key within the mission (used by plans, fixtures and reuse). */
  key: string;
  title: string;
  executor: TaskExecutor;
  status: TaskStatus;
  owner_id: string;
  contract: DelegationContract;
  contract_hash: Sha256;
  /** Fencing epoch. Every lease increments it; writes carrying an older value are rejected. */
  attempt: number;
  lease_owner: string | null;
  lease_expires_at: Iso | null;
  heartbeat_at: Iso | null;
  depth: number;
  priority: number;
  currency: Currency;
  /** Invalidation generation. A receipt for generation g cannot clear generation g+1. */
  generation: number;
  retries: number;
  repairs: number;
  budget_account_id: string;
  blocked_reason: string | null;
  next_action: NextAction | null;
  competing_group: string | null;
  scope_signature: string | null;
  created_at: Iso;
  updated_at: Iso;
  revision: number;
}

export type AttemptStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'killed'
  | 'expired' // lease expired without a result
  | 'cancelled'
  | 'superseded' // fenced off by a newer attempt or an upstream change
  | 'rate_limited'
  | 'invalid_output';

export interface Attempt {
  id: string;
  task_id: string;
  mission_id: string;
  attempt_no: number;
  agent_id: string;
  provider: string;
  provider_mode: ProviderMode;
  pid: number | null;
  session_id: string | null;
  status: AttemptStatus;
  model_requested: string | null;
  model_actual: string | null;
  usage: UsageRecord | null;
  error: { code: string; message: string } | null;
  workspace: { dir: string; branch: string | null; base_commit: string | null; head_commit: string | null } | null;
  release_id: string;
  generation: number;
  started_at: Iso;
  ended_at: Iso | null;
}

/** Never synthesize missing prices. `reported_cost` is whatever the provider reported, with its basis. */
export interface UsageRecord {
  source: string; // which meter produced this
  meter_kind: 'provider_reported' | 'runtime_measured' | 'fixture_declared';
  call_count: number;
  input_units: number | null;
  output_units: number | null;
  cache_read_units: number | null;
  cache_write_units: number | null;
  wall_ms: number;
  reported_cost: number | null;
  currency: string | null;
  /** `list_price_estimate` is a client-side estimate, not billing. Subscription usage has no per-call bill. */
  cost_basis: 'list_price_estimate' | 'measured_billing' | 'none';
  completeness: 'complete' | 'partial' | 'unknown';
  observed_at: Iso;
}

export interface Swarm {
  id: string;
  mission_id: string;
  parent_swarm_id: string | null;
  archetype: SwarmArchetype;
  /** Bounded purpose, owner, budget, deliverable and stopping condition are all mandatory. */
  purpose: string;
  lead_agent_id: string;
  deliverable: string;
  stopping_condition: string;
  budget_account_id: string;
  container_task_id: string | null;
  temporary: boolean;
  status: 'active' | 'completed' | 'disbanded' | 'cancelled';
  depth: number;
  created_at: Iso;
}

export interface Agent {
  id: string;
  mission_id: string;
  swarm_id: string | null;
  archetype: SwarmArchetype;
  role: string;
  model_requested: string | null;
  status: 'active' | 'idle' | 'retired';
  created_at: Iso;
}

// ───────────────────────────── artifacts, evidence, verification ─────────────────────────────

export interface Artifact {
  id: string;
  mission_id: string;
  key: string;
  kind: ArtifactKind;
  current_version_id: string | null;
  created_at: Iso;
}

export interface ArtifactVersion {
  id: string;
  artifact_id: string;
  mission_id: string;
  key: string;
  version_no: number;
  content_hash: Sha256;
  /** Blob path relative to the artifact store, or `git:<sha>` for code. */
  content_ref: string;
  media_type: string;
  size: number;
  produced_by_task_id: string | null;
  produced_by_attempt: number | null;
  /** Exact input versions this was derived from. */
  input_manifest: InputRef[];
  release_id: string | null;
  currency: Currency;
  supersedes: string | null;
  source: SourceLabel;
  created_at: Iso;
}

export interface Evidence {
  id: string;
  mission_id: string;
  task_id: string | null;
  kind: string; // test_result | observation | source_excerpt | measurement | review_note …
  /** Observed fact vs. interpretation is never collapsed. */
  epistemic: 'observed_fact' | 'interpretation';
  /** Business evidence vs. agent-generated suggestion. */
  origin: 'business' | 'agent' | 'runtime';
  /** Synthetic evidence can never satisfy an empirical requirement. */
  evidence_class: 'empirical' | 'synthetic';
  statement: string;
  canonical_ref: string | null;
  artifact_version_id: string | null;
  content_hash: Sha256 | null;
  producer_id: string;
  freshness_status: 'fresh' | 'stale' | 'unknown';
  verification_status: 'unverified' | 'verified' | 'refuted';
  observed_at: Iso;
}

export interface Verification {
  id: string;
  mission_id: string;
  task_id: string; // the task whose result is verified
  verifier_task_id: string | null;
  target_version_id: string | null;
  criterion_id: string;
  method: VerificationKind;
  verdict: 'pass' | 'fail' | 'inconclusive';
  evidence_ids: string[];
  verifier_id: string;
  /** True when the verifier is not the author of the result. */
  independent: boolean;
  generation: number;
  details: Record<string, unknown>;
  created_at: Iso;
}

export interface Handoff {
  id: string;
  mission_id: string;
  task_id: string;
  from_owner: string;
  to_owner: string;
  artifact_version_id: string | null;
  acceptance_evidence_ids: string[];
  remaining_uncertainty: string[];
  /** A pending handoff keeps the original owner until it is accepted. */
  status: 'offered' | 'accepted' | 'rejected' | 'expired';
  note: string | null;
  created_at: Iso;
  resolved_at: Iso | null;
}

// ───────────────────────────── communication and decisions ─────────────────────────────

export interface Message {
  id: string;
  mission_id: string;
  task_id: string | null;
  from_id: string;
  /** Direct recipient or `topic:<name>`; routing expands topics to subscribers. */
  to: string;
  kind: 'question' | 'answer' | 'handoff' | 'proposal' | 'notice' | 'escalation';
  body: string;
  /** Large results travel as artifact references, never inline. */
  artifact_refs: string[];
  in_reply_to: string | null;
  status: 'open' | 'answered' | 'closed';
  delivered_to: string[];
  bytes: number;
  created_at: Iso;
}

export interface DecisionOption {
  id: string;
  label: string;
  evidence_ids: string[];
  consequences: string[];
  proposed_by: string;
}

export interface Decision {
  id: string;
  mission_id: string | null;
  task_id: string | null;
  kind: string; // conflict | selection | plan_change | topology_change | rule_change | migration | outward_action …
  question: string;
  /** A named decision owner. */
  owner_id: string;
  owner_kind: ActorKind;
  status: 'open' | 'resolved' | 'escalated' | 'superseded' | 'expired';
  options: DecisionOption[];
  chosen: string | null;
  rationale: string | null;
  /** Debate is bounded; after `max_rounds` the decision resolves or escalates. */
  round: number;
  max_rounds: number;
  requires_human: boolean;
  supersedes: string | null;
  superseded_by: string | null;
  created_at: Iso;
  resolved_at: Iso | null;
}

/** Outward-facing work is only ever drafted; a human reviews the final form. */
export interface Draft {
  id: string;
  mission_id: string;
  kind: OutwardAction;
  audience: string;
  title: string;
  body: string;
  context_refs: string[];
  status: 'awaiting_review' | 'approved' | 'rejected' | 'withdrawn';
  reviewed_by: string | null;
  review_note: string | null;
  created_at: Iso;
  reviewed_at: Iso | null;
}

// ───────────────────────────── intake ─────────────────────────────

export interface IntakeRequest {
  id: string; // synthetic ids begin with `syn-`
  source: string; // connector label, e.g. `local-fixture:slack`
  stakeholder: string;
  team: string;
  text: string;
  received_at: Iso;
  data_class: DataClass;
  signature: { terms: string[]; capability_tags: string[] };
  cluster_id: string | null;
  mission_id: string | null;
}

export interface StakeholderNeed {
  id: string;
  request_id: string;
  mission_id: string | null;
  stakeholder: string;
  need: string;
  /** Distinct needs survive consolidation by mapping to their own acceptance criterion. */
  criterion_id: string | null;
  status: 'open' | 'mapped' | 'deferred' | 'satisfied';
}

// ───────────────────────────── memory ─────────────────────────────

export type MemoryKind =
  | 'fact'
  | 'interpretation'
  | 'procedure'
  | 'failed_approach'
  | 'decision'
  | 'correction'
  | 'skill_candidate';

export interface Memory {
  id: string;
  kind: MemoryKind;
  statement: string;
  /** Where this is valid: archetype, task kind, scenario, component … */
  scope: string[];
  provenance: {
    mission_id: string | null;
    task_id: string | null;
    evidence_ids: string[];
    artifact_version_ids: string[];
    release_id: string | null;
    recorded_by: string;
  };
  origin: 'business' | 'agent' | 'runtime';
  /** A failed approach is either a verified failure or only a suspected cause. */
  certainty: 'verified' | 'suspected' | 'untested';
  status: 'active' | 'invalidated' | 'expired' | 'superseded';
  fresh_until: Iso | null;
  invalidated_by: string | null;
  superseded_by: string | null;
  validated_cases: number;
  evidence_class: 'empirical' | 'synthetic';
  created_at: Iso;
}

export interface SkillDefinition {
  id: string;
  version: number;
  title: string;
  prerequisites: string[];
  supported_situations: string[];
  procedure: string[];
  /** Executable validators (file names inside the bundle) the procedure runs. */
  validators: string[];
  /** Verification steps that may not be omitted; the gate checks candidates against this list. */
  required_steps: string[];
  expected_outputs: string[];
  verification: string[];
  known_failure_cases: string[];
  status: 'untested' | 'validated' | 'default' | 'retired';
}

// ───────────────────────────── outcomes and observations ─────────────────────────────

export interface Outcome {
  id: string;
  mission_id: string;
  task_id: string | null;
  terminal_state: 'accepted' | 'failed' | 'cancelled';
  /** Independently accepted: every mandatory criterion passed a verification the author did not perform. */
  verified_success: boolean;
  criterion_results: { criterion_id: string; verdict: 'pass' | 'fail' | 'inconclusive'; independent: boolean }[];
  escaped_defects: number | null;
  rework_count: number;
  integration_failures: number;
  human_corrections: number;
  recovery_events: number;
  total_usage: ResourceAmounts;
  elapsed_ms: number;
  critical_path_wait_ms: number | null;
  messages: number;
  message_bytes: number;
  release_id: string;
  source: SourceLabel;
  label_source: 'executable_check' | 'independent_review' | 'human';
  created_at: Iso;
}

export interface Observation {
  id: string;
  mission_id: string | null;
  task_id: string | null;
  kind:
    | 'acceptance_failure'
    | 'escaped_defect'
    | 'integration_failure'
    | 'rework'
    | 'human_correction'
    | 'stall'
    | 'recovery'
    | 'repeated_mistake'
    | 'rejected_proposal';
  failure_class: string;
  signature: string;
  /** Verified failure vs. suspected cause. */
  certainty: 'verified' | 'suspected';
  details: Record<string, unknown>;
  component: string | null; // which versioned component is implicated
  release_id: string | null;
  source: SourceLabel;
  created_at: Iso;
}

// ───────────────────────────── releases and evolution ─────────────────────────────

export type ComponentLevel = 'execution' | 'coordination' | 'evolution';

export interface ComponentVersion {
  level: ComponentLevel;
  version: number;
  parent_version: number | null;
  content_hash: Sha256;
  summary: string;
  created_at: Iso;
}

export interface ReleaseManifest {
  release_id: string;
  parent_release_id: string | null;
  /** The three levels are versioned independently. */
  components: Record<ComponentLevel, { version: number; content_hash: Sha256 }>;
  /** Protected evaluation protocol the release was approved under. Not candidate-writable. */
  policy_hash: Sha256;
  evaluation_snapshot_hash: Sha256 | null;
  receipt_id: string | null;
  rollback_target: string | null;
  status: 'baseline' | 'canary' | 'active' | 'retired' | 'rolled_back';
  /** What kind of evidence backs this release. Fixture evidence never certifies live use. */
  evidence_basis: 'baseline' | 'fixture' | 'simulation' | 'live';
  created_at: Iso;
  manifest_hash: Sha256;
}

export type GateKind = 'HARD_GATE' | 'WEIGHTED';
export type GateVerdict = 'PASSED' | 'FAILED' | 'REMAINING' | 'NOT_APPLICABLE';

export interface GateResult {
  id: string;
  name: string;
  kind: GateKind;
  verdict: GateVerdict;
  measurement_value: number | null;
  measurement_unit: string | null;
  comparison_operator: string;
  threshold: number | null;
  samples: number;
  minimum_samples: number;
  weight: number | null;
  meaning: string;
}

export type ExperimentDecision = 'accept' | 'reject' | 'inconclusive';

export type ExperimentStage =
  | 'observed'
  | 'hypothesized'
  | 'frozen'
  | 'candidate_built'
  | 'dev_checked'
  | 'evaluated'
  | 'decided'
  | 'canary'
  | 'retained'
  | 'rolled_back'
  | 'recorded';

export interface MetricComparison {
  metric: string;
  unit: string;
  higher_is_better: boolean;
  candidate: number | null;
  incumbent: number | null;
  baseline: number | null;
  /** candidate − incumbent */
  diff_vs_incumbent: number | null;
  ci95_vs_incumbent: [number, number] | null;
  diff_vs_baseline: number | null;
  ci95_vs_baseline: [number, number] | null;
  n: number;
  method: string;
}

/** The improvement receipt. Preserved whether the decision is accept, reject or inconclusive. */
export interface ImprovementReceipt {
  receipt_id: string;
  experiment_id: string;
  level: ComponentLevel;
  problem: { statement: string; observation_ids: string[]; observed_failure_count: number };
  hypothesis: string;
  expected_benefit: string;
  possible_regressions: string[];
  parent: { component: ComponentLevel; version: number; content_hash: Sha256 };
  change: { summary: string; files: { path: string; before_hash: Sha256 | null; after_hash: Sha256 }[]; candidate_hash: Sha256 };
  evaluation: {
    protocol_id: string;
    policy_hash: Sha256;
    frozen_at: Iso;
    workload_refs: string[];
    holdout_set: string;
    executor: string;
    /** `replay` re-scores recorded outputs; `rerun` executes again. */
    execution_kind: 'rerun' | 'replay';
    repeats: number;
    deterministic: boolean;
    source: SourceLabel;
  };
  attempts: { attempt_no: number; kind: 'development' | 'holdout'; at: Iso; cases: number; note: string }[];
  resource_use: { experiment_units: number; wall_ms: number; model_calls: number; cost_usd_est: number | null };
  comparisons: MetricComparison[];
  gates: GateResult[];
  known_regressions: string[];
  limitations: string[];
  decision: ExperimentDecision;
  justification: string;
  decided_by: string;
  decided_at: Iso;
  release_manifest: ReleaseManifest | null;
  rollback_target: string | null;
  isolation: IsolationReport;
  evidence_basis: 'fixture' | 'simulation' | 'live';
  receipt_hash: Sha256;
}

export interface IsolationReport {
  /** `enforced` = OS user separation; `seatbelt` = Node permission model only; `procedural` = path checks and digests only. */
  mode: 'enforced' | 'seatbelt' | 'procedural';
  uid_separation: boolean;
  candidate_uid: number | null;
  node_permission_model: boolean;
  protected_digest_before: Sha256;
  protected_digest_after: Sha256;
  intact: boolean;
  notes: string[];
}

export interface CanaryRecord {
  id: string;
  release_id: string;
  prior_release_id: string;
  scope: { max_missions: number; data_class: DataClass; scenario: string | null };
  status: 'running' | 'retained' | 'rolled_back';
  missions: string[];
  observations: { at: Iso; metric: string; value: number | null; threshold: number | null; breached: boolean; injected: boolean }[];
  started_at: Iso;
  ended_at: Iso | null;
  reason: string | null;
}

// ───────────────────────────── events ─────────────────────────────

export interface RunEvent {
  seq: number;
  event_id: string;
  ts: Iso;
  type: string;
  mission_id: string | null;
  task_id: string | null;
  actor_id: string;
  actor_kind: ActorKind;
  idempotency_key: string | null;
  payload: Record<string, unknown>;
  release_id: string | null;
  prev_hash: Sha256;
  hash: Sha256;
}

// ───────────────────────────── worker protocol ─────────────────────────────

export interface WorkOutput {
  status: 'completed' | 'blocked' | 'failed';
  summary: string;
  artifacts: { key: string; kind: ArtifactKind; media_type: string; content?: string; path?: string }[];
  evidence: {
    kind: string;
    statement: string;
    epistemic: 'observed_fact' | 'interpretation';
    origin: 'business' | 'agent' | 'runtime';
    refs: string[];
  }[];
  criteria_claims: { criterion_id: string; claimed: 'met' | 'not_met' | 'unknown'; note: string }[];
  remaining_uncertainty: string[];
  questions: { to: string; question: string; blocking: boolean }[];
  proposals: { kind: 'subteam' | 'plan_change' | 'topology_change' | 'decision' | 'memory'; payload: Record<string, unknown> }[];
  plan?: PlanProposal;
}

/** What an agent proposes; the runtime validates it before anything is created. */
export interface PlanProposal {
  topology: Topology;
  /**
   * Where the plan attaches. Only mission coordination (the planning swarm) may anchor at the
   * mission; any other lead may only decompose inside its own swarm.
   */
  anchor: 'mission' | 'own_swarm';
  rationale: string;
  swarms: {
    ref: string;
    archetype: SwarmArchetype;
    parent_ref: string | null;
    purpose: string;
    deliverable: string;
    stopping_condition: string;
    budget_share: number;
    temporary: boolean;
    /** Tasks or teams that must be accepted before this team starts. */
    depends_on: string[];
  }[];
  tasks: {
    ref: string;
    swarm_ref: string;
    title: string;
    objective: string;
    executor: TaskExecutor;
    role: string;
    depends_on: string[];
    /** Tasks whose submitted result this task independently verifies. */
    verifies: string[];
    input_keys: string[];
    outputs: { key: string; kind: ArtifactKind; description: string }[];
    /** Executor-specific parameters (merge order, acceptance suite, failure attribution …). */
    params: Record<string, unknown>;
    acceptance_criteria: AcceptanceCriterion[];
    verification: { method: 'executable' | 'independent_review' | 'both' | 'none'; independent: boolean };
    write_scope: string[];
    budget_share: number;
    budget_class: BudgetClass;
    competing_group: string | null;
    risk_tier: RiskTier;
  }[];
  /** Interfaces two or more workstreams must agree on before parallel implementation. */
  interface_agreements: { artifact_key: string; between: string[] }[];
  /** Extra prerequisites for tasks that already exist inside the proposer's own swarm. */
  extra_dependencies: { task_key: string; depends_on: string[] }[];
}

// ───────────────────────────── review packet ─────────────────────────────

export interface ReviewPacket {
  mission_id: string;
  title: string;
  /** Two cold-read lines: what this governs and what happened; what to do next and what it changes. */
  cold_read: [string, string];
  context: string;
  requests: { id: string; stakeholder: string; team: string; text: string }[];
  overlap: { shared_capability: string; distinct_needs: { stakeholder: string; need: string; criterion_id: string | null; status: string }[] };
  exact_changes: { ref: string; base_commit: string | null; head_commit: string | null; files: { path: string; status: string }[] } | null;
  acceptance: { criterion_id: string; description: string; mandatory: boolean; stakeholder: string | null; verdict: string; independent: boolean; evidence_ids: string[] }[];
  artifacts: { key: string; version_no: number; content_hash: Sha256; currency: Currency; kind: ArtifactKind }[];
  decisions: { id: string; question: string; chosen: string | null; owner_id: string; status: string }[];
  remaining_concerns: string[];
  decision_requested: { decision_id: string | null; question: string; options: string[]; consequence: string; reversible: boolean };
  resource_use: ResourceAmounts & { cost_basis: string; usage_completeness: string };
  release_id: string;
  provider_mode: ProviderMode;
  data_class: DataClass;
  generated_at: Iso;
}

export const ZERO_AMOUNTS: ResourceAmounts = Object.freeze({
  model_calls: 0,
  worker_invocations: 0,
  tokens: 0,
  cost_usd_est: 0,
  wall_ms: 0,
});
