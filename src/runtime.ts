import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CoordinationDef, EvolutionDef, ExecutionDef } from './contracts/definitions.ts';
import type { AcceptanceCriterion, LimitsProfile, Mission, PlanProposal, ReleaseManifest, Task } from './contracts/types.ts';
import { REPO_ROOT, type Paths, loadLimits, paths } from './config.ts';
import { Comms } from './kernel/comms.ts';
import { Intake } from './kernel/intake.ts';
import { Kernel } from './kernel/kernel.ts';
import { ClaudeCliProvider } from './providers/claude-cli.ts';
import { FixtureProvider } from './providers/fixture.ts';
import type { Provider } from './providers/provider.ts';
import { Registry } from './gate/registry.ts';
import { Store } from './store/store.ts';
import { type Clock, sha256, systemClock } from './lib/util.ts';
import { Workspaces } from './workspace/workspaces.ts';

export interface Runtime {
  paths: Paths;
  limits: LimitsProfile;
  store: Store;
  kernel: Kernel;
  comms: Comms;
  intake: Intake;
  workspaces: Workspaces;
  registry: Registry;
  providers: { fixture: Provider; live: ClaudeCliProvider };
  close(): void;
}

/** Open the durable runtime rooted at `home`. Everything the organization knows is under this directory. */
export function openRuntime(opts: { home?: string; limits?: Partial<LimitsProfile>; clock?: Clock } = {}): Runtime {
  const p = paths(opts.home);
  mkdirSync(p.home, { recursive: true });
  const limits = loadLimits(opts.limits);
  const store = new Store(p.db, opts.clock ?? systemClock);
  const kernel = new Kernel(store, limits, p.artifacts);
  const registry = new Registry(p.protected);
  return {
    paths: p,
    limits,
    store,
    kernel,
    comms: new Comms(store),
    intake: new Intake(store),
    workspaces: new Workspaces(p.workspaces),
    registry,
    providers: { fixture: new FixtureProvider(), live: new ClaudeCliProvider(limits, join(p.home, 'live-scratch')) },
    close: () => store.close(),
  };
}

/** Install the baseline release from the committed definitions if this home has none yet. */
export function ensureBaseline(rt: Runtime): ReleaseManifest {
  if (rt.registry.exists()) return rt.registry.manifest(rt.registry.active());
  const policy = join(REPO_ROOT, 'protected', 'policy.json');
  const policy_hash = existsSync(policy) ? sha256(readFileSync(policy)) : sha256('no-policy');
  return rt.registry.init(join(REPO_ROOT, 'definitions'), policy_hash, rt.store.clock.iso());
}

export interface ReleaseDefs {
  release_id: string;
  execution: ExecutionDef;
  coordination: CoordinationDef;
  evolution: EvolutionDef;
}

export function loadDefs(rt: Runtime, release_id: string): ReleaseDefs {
  return {
    release_id,
    execution: rt.registry.load<ExecutionDef>(release_id, 'execution'),
    coordination: rt.registry.load<CoordinationDef>(release_id, 'coordination'),
    evolution: rt.registry.load<EvolutionDef>(release_id, 'evolution'),
  };
}

// ───────── scenarios ─────────

export interface InspectorCtx {
  task: Task;
  mission: Mission;
  criterion: AcceptanceCriterion;
  /** The task's output artifacts for the current generation, by key. */
  artifacts: Record<string, string>;
  rt: Runtime;
}

export type Inspector = (ctx: InspectorCtx) => { ok: boolean; details: string };

export interface ScenarioConfig {
  name: string;
  description: string;
  /** Directory (inside the scenario) copied to seed the mission repository. */
  app_seed: string | null;
  /** Directory of protected acceptance tests, copied in only at verification time. */
  acceptance_dir: string | null;
  /** Artifact key → path inside a worktree where a pinned input is written. */
  materialize: Record<string, string>;
  synthetic: boolean;
}

export interface Scenario {
  name: string;
  dir: string;
  config: ScenarioConfig;
  bootstrapPlan(ctx: { mission: Mission; defs: ReleaseDefs; criteria?: AcceptanceCriterion[] }): PlanProposal;
  inspectors: Record<string, Inspector>;
}

const cache = new Map<string, Scenario>();

export async function loadScenario(name: string): Promise<Scenario> {
  const hit = cache.get(name);
  if (hit) return hit;
  const dir = join(REPO_ROOT, 'fixtures', 'scenarios', name);
  const cfgPath = join(dir, 'scenario.json');
  if (!existsSync(cfgPath)) throw new Error(`unknown scenario ${name}`);
  const config = JSON.parse(readFileSync(cfgPath, 'utf8')) as ScenarioConfig;
  const plan = (await import(pathToFileURL(join(dir, 'plan.ts')).href)) as { bootstrapPlan: Scenario['bootstrapPlan'] };
  const insp = existsSync(join(dir, 'inspectors.ts')) ? ((await import(pathToFileURL(join(dir, 'inspectors.ts')).href)) as { inspectors: Record<string, Inspector> }) : { inspectors: {} };
  const scenario: Scenario = { name, dir, config, bootstrapPlan: plan.bootstrapPlan, inspectors: { ...BUILTIN_INSPECTORS, ...insp.inspectors } };
  cache.set(name, scenario);
  return scenario;
}

export const BUILTIN_INSPECTORS: Record<string, Inspector> = {
  nonempty: ({ artifacts, task }) => {
    const missing = task.contract.required_outputs.filter((o) => o.kind !== 'code' && !(artifacts[o.key] ?? '').trim());
    return { ok: missing.length === 0, details: missing.length ? `missing or empty: ${missing.map((m) => m.key).join(', ')}` : 'all required outputs are present and non-empty' };
  },
  json: ({ artifacts, task }) => {
    for (const o of task.contract.required_outputs) {
      try {
        JSON.parse(artifacts[o.key] ?? '');
      } catch {
        return { ok: false, details: `${o.key} is not valid JSON` };
      }
    }
    return { ok: true, details: 'required outputs parse as JSON' };
  },
};
