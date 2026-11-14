// Runs candidate-authored code. This process is started by the release gate with reduced
// privileges: an unprivileged uid where available, and Node's permission model restricted to
// reading this file and the candidate bundle. It speaks one JSON object per line on stdin/stdout.
//
// Nothing here is trusted by the gate: answers are scored against labels this process never sees,
// and cost is measured from outside.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let validators = [];
let policy = null;
const cache = new Map();

async function handle(req) {
  if (req.op === 'load_skill') {
    const def = JSON.parse(readFileSync(join(req.bundle_dir, 'execution.json'), 'utf8'));
    const skill = def.skills?.[req.skill_id];
    if (!skill) throw new Error(`bundle has no skill ${req.skill_id}`);
    validators = [];
    for (const file of skill.validators ?? []) {
      const mod = await import(pathToFileURL(join(req.bundle_dir, 'validators', file)).href);
      validators.push({ file, id: mod.id ?? file, check: mod.check });
    }
    return { validators: validators.map((v) => v.id) };
  }
  if (req.op === 'review') {
    const outputs = [];
    for (const c of req.cases) {
      const findings = [];
      const errors = [];
      for (const v of validators) {
        try {
          const res = v.check(structuredClone(c));
          for (const f of Array.isArray(res) ? res : []) findings.push({ step: String(f.step ?? v.id), class: String(f.class ?? 'unknown'), field: f.field == null ? null : String(f.field), severity: f.severity === 'blocking' ? 'blocking' : 'advisory', message: String(f.message ?? '').slice(0, 300) });
        } catch (err) {
          errors.push(`${v.id}: ${String(err && err.message ? err.message : err).slice(0, 200)}`);
        }
      }
      outputs.push({ id: c.id, verdict: findings.some((f) => f.severity === 'blocking') ? 'request_changes' : 'approve', findings, steps_run: validators.length, errors });
    }
    return { outputs };
  }
  if (req.op === 'review_set') {
    // Run an explicit set of validator files (absolute paths) over cases. Modules are cached.
    const mods = [];
    for (const file of req.files) {
      if (!cache.has(file)) cache.set(file, await import(pathToFileURL(file).href));
      mods.push(cache.get(file));
    }
    const outputs = [];
    for (const c of req.cases) {
      const findings = [];
      for (const m of mods) {
        try {
          for (const f of m.check(structuredClone(c)) ?? []) findings.push({ step: String(f.step ?? m.id), class: String(f.class ?? 'unknown'), field: f.field == null ? null : String(f.field), severity: f.severity === 'blocking' ? 'blocking' : 'advisory', message: String(f.message ?? '').slice(0, 300) });
        } catch {
          /* a failing validator contributes no finding */
        }
      }
      outputs.push({ id: c.id, verdict: findings.some((f) => f.severity === 'blocking') ? 'request_changes' : 'approve', findings, steps_run: mods.length });
    }
    return { outputs };
  }
  if (req.op === 'load_policy') {
    const mod = await import(pathToFileURL(join(req.bundle_dir, req.module)).href);
    if (typeof mod.decide !== 'function') throw new Error('policy module exports no decide()');
    policy = mod;
    return { policy: String(mod.id ?? req.module) };
  }
  if (req.op === 'decide') {
    if (!policy) throw new Error('no policy loaded');
    const action = policy.decide(structuredClone(req.state));
    return { action: action && typeof action === 'object' ? action : { type: 'stop', reason: 'policy returned no action' } };
  }
  throw new Error(`unknown op ${req.op}`);
}

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    continue;
  }
  try {
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, ...(await handle(req)) }) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: String(err && err.code ? `${err.code}: ${err.message}` : err && err.message ? err.message : err).slice(0, 400) }) + '\n');
  }
}
