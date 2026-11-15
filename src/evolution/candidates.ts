import { rejectLinks } from '../gate/scope.ts';
import { SwarmError } from '../lib/util.ts';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutionDef } from '../contracts/definitions.ts';
import type { ComponentLevel, Sha256 } from '../contracts/types.ts';
import { hashDir, listFiles } from '../gate/registry.ts';

export interface CandidateSpec {
  candidate_id: string;
  level: ComponentLevel;
  title: string;
  problem: string;
  failure_classes: string[];
  hypothesis: string;
  expected_benefit: string;
  possible_regressions: string[];
  change_summary: string;
  /** The candidate this one was revised from after an evaluation, if any. Decides its lineage. */
  revises: string | null;
  declared_simplification: boolean;
  skill_patch?: { skill_id: string; validators_add: string[]; validators_remove: string[]; procedure: string[]; known_failure_cases: string[] };
  /** For evolution-level candidates: a shallow patch of `evolution.json`. */
  definition_patch?: Record<string, unknown>;
}

export interface BuiltCandidate {
  spec: CandidateSpec;
  dir: string;
  content_hash: Sha256;
  parent_hash: Sha256;
  files: { path: string; before_hash: Sha256 | null; after_hash: Sha256 }[];
}

function substitute(dir: string, subst: Record<string, string>): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) substitute(p, subst);
    else if (/\.(mjs|js|json|md)$/.test(name)) {
      let text = readFileSync(p, 'utf8');
      for (const [k, v] of Object.entries(subst)) text = text.replaceAll(k, v);
      writeFileSync(p, text);
    }
  }
}

/**
 * Build a candidate bundle in an isolated workspace: the parent component version with the
 * candidate's files laid over it and its definition patch applied. This is the candidate
 * author's work product. Nothing here touches the registry or the protected store.
 */
export function buildCandidate(parentDir: string, specDir: string, outDir: string, subst: Record<string, string> = {}): BuiltCandidate {
  rejectLinks(specDir);
  rejectLinks(parentDir);
  const spec = JSON.parse(readFileSync(join(specDir, 'candidate.json'), 'utf8')) as CandidateSpec;
  if (!['execution', 'coordination', 'evolution'].includes(spec.level)) throw new SwarmError('invalid_candidate', 'Unknown component level');
  if (spec.skill_patch && (!Array.isArray(spec.skill_patch.validators_add) || !Array.isArray(spec.skill_patch.validators_remove) || ![...spec.skill_patch.validators_add, ...spec.skill_patch.validators_remove].every((f) => /^[\w-]+\.mjs$/.test(f)))) throw new SwarmError('invalid_candidate', 'Invalid validator path');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(parentDir, outDir, { recursive: true });
  if (existsSync(join(specDir, 'files'))) cpSync(join(specDir, 'files'), outDir, { recursive: true });
  substitute(outDir, subst);
  const defPath = join(outDir, `${spec.level}.json`);
  const def = JSON.parse(readFileSync(defPath, 'utf8')) as Record<string, unknown> & { version: number; summary: string };
  if (spec.level === 'execution' && spec.skill_patch) {
    const ex = def as unknown as ExecutionDef;
    const skill = ex.skills[spec.skill_patch.skill_id]!;
    skill.validators = [...skill.validators.filter((v) => !spec.skill_patch!.validators_remove.includes(v) && !spec.skill_patch!.validators_add.includes(v)), ...spec.skill_patch.validators_add];
    for (const removed of spec.skill_patch.validators_remove) rmSync(join(outDir, 'validators', removed), { force: true });
    skill.procedure = spec.skill_patch.procedure;
    skill.known_failure_cases = spec.skill_patch.known_failure_cases;
    skill.version += 1;
    // A changed skill is untested until it has been validated on additional cases.
    skill.status = 'untested';
  }
  if (spec.definition_patch) Object.assign(def, spec.definition_patch);
  def.version = Number(def.version) + 1;
  def.summary = spec.change_summary;
  writeFileSync(defPath, JSON.stringify(def, null, 2) + '\n');
  const before = new Map(listFiles(parentDir).map((f) => [f.path, f.hash]));
  const after = listFiles(outDir);
  const files = after.filter((f) => before.get(f.path) !== f.hash).map((f) => ({ path: f.path, before_hash: before.get(f.path) ?? null, after_hash: f.hash }));
  for (const [path, hash] of before) if (!after.some((f) => f.path === path)) files.push({ path: `${path} (removed)`, before_hash: hash, after_hash: '' });
  return { spec, dir: outDir, content_hash: hashDir(outDir), parent_hash: hashDir(parentDir), files };
}
