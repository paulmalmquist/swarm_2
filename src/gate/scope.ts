import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashOf, SwarmError } from '../lib/util.ts';
import { listFiles } from './registry.ts';

export function rejectLinks(dir: string): void {
  if (lstatSync(dir).isSymbolicLink()) throw new SwarmError('unsafe_bundle', 'Candidate bundles cannot contain symlinks');
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), st = lstatSync(p);
    if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) throw new SwarmError('unsafe_bundle', `Not a regular file: ${name}`);
    if (st.isDirectory()) rejectLinks(p);
  }
}

/** The execution benchmark certifies one skill, not routing, prompts, retries or context. */
export function validateExecutionScope(parent: string, candidate: string, skillId: string): void {
  const before = JSON.parse(readFileSync(join(parent, 'execution.json'), 'utf8'));
  const after = JSON.parse(readFileSync(join(candidate, 'execution.json'), 'utf8'));
  const original = before.skills?.[skillId], changed = after.skills?.[skillId];
  if (!original || !changed || !Array.isArray(changed.validators) || !changed.validators.every((v: unknown) => typeof v === 'string' && /^[\w-]+\.mjs$/.test(v))) throw new SwarmError('unevaluated_change', 'Invalid evaluated skill or validator paths');
  const allowedFiles = new Set(['execution.json', ...[...original.validators, ...changed.validators].map((v: string) => `validators/${v}`)]);
  // Version/description and descriptive skill text are bookkeeping, never capability evidence.
  for (const d of [before, after]) {
    delete d.version; delete d.summary;
    for (const k of ['version', 'status', 'procedure', 'known_failure_cases', 'validators']) delete d.skills[skillId][k];
  }
  if (hashOf(before) !== hashOf(after)) throw new SwarmError('unevaluated_change', 'Execution candidate changes settings outside the evaluated skill');
  const oldFiles = new Map(listFiles(parent).map((f) => [f.path, f.hash]));
  const newFiles = new Map(listFiles(candidate).map((f) => [f.path, f.hash]));
  for (const path of new Set([...oldFiles.keys(), ...newFiles.keys()])) {
    if (oldFiles.get(path) !== newFiles.get(path) && !allowedFiles.has(path)) throw new SwarmError('unevaluated_change', `No evaluator covers ${path}`);
  }
}
