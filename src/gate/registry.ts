import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ComponentLevel, ReleaseManifest, Sha256 } from '../contracts/types.ts';
import { SwarmError, hashOf, sha256 } from '../lib/util.ts';

export const LEVELS: ComponentLevel[] = ['execution', 'coordination', 'evolution'];

/** Hash of a directory: sorted relative paths and file bytes. */
export function hashDir(dir: string): Sha256 {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  return sha256(files.map((f) => `${relative(dir, f)}\0${sha256(readFileSync(f))}`).join('\n'));
}

export function listFiles(dir: string): { path: string; hash: Sha256 }[] {
  const out: { path: string; hash: Sha256 }[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: relative(dir, p), hash: sha256(readFileSync(p)) });
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/**
 * The release registry: immutable component versions and release manifests.
 *
 * It lives inside the protected directory. The coordinator and workers only read it;
 * the release gate is the only writer. Execution, coordination and evolution definitions are
 * versioned independently and a release pins one version of each.
 */
export class Registry {
  dir: string;

  constructor(protectedDir: string) {
    this.dir = join(protectedDir, 'registry');
  }

  componentDir(level: ComponentLevel, version: number): string {
    return join(this.dir, 'components', level, `v${version}`);
  }

  private releasePath(id: string): string {
    return join(this.dir, 'releases', `${id}.json`);
  }

  exists(): boolean {
    return existsSync(join(this.dir, 'ACTIVE'));
  }

  /** Install the baseline release from the committed definitions. Idempotent. */
  init(definitionsDir: string, policy_hash: Sha256, now: string): ReleaseManifest {
    if (this.exists()) return this.manifest('r1');
    mkdirSync(join(this.dir, 'releases'), { recursive: true });
    const components = {} as ReleaseManifest['components'];
    for (const level of LEVELS) {
      const dest = this.componentDir(level, 1);
      mkdirSync(dest, { recursive: true });
      cpSync(join(definitionsDir, level, 'v1'), dest, { recursive: true });
      components[level] = { version: 1, content_hash: hashDir(dest) };
    }
    const manifest = this.writeRelease({ release_id: 'r1', parent_release_id: null, components, policy_hash, evaluation_snapshot_hash: null, receipt_id: null, rollback_target: null, status: 'active', evidence_basis: 'baseline', created_at: now });
    writeFileSync(join(this.dir, 'ACTIVE'), 'r1\n');
    writeFileSync(join(this.dir, 'BASELINE'), 'r1\n');
    return manifest;
  }

  writeRelease(m: Omit<ReleaseManifest, 'manifest_hash'>): ReleaseManifest {
    const manifest: ReleaseManifest = { ...m, manifest_hash: hashOf({ ...m, status: undefined }) };
    mkdirSync(join(this.dir, 'releases'), { recursive: true });
    writeFileSync(this.releasePath(m.release_id), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  }

  manifest(release_id: string): ReleaseManifest {
    const p = this.releasePath(release_id);
    if (!existsSync(p)) throw new SwarmError('unknown_release', `Release ${release_id} is not in the registry`);
    return JSON.parse(readFileSync(p, 'utf8')) as ReleaseManifest;
  }

  list(): ReleaseManifest[] {
    const d = join(this.dir, 'releases');
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(d, f), 'utf8')) as ReleaseManifest)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.release_id.localeCompare(b.release_id));
  }

  active(): string {
    return readFileSync(join(this.dir, 'ACTIVE'), 'utf8').trim();
  }

  baseline(): string {
    return readFileSync(join(this.dir, 'BASELINE'), 'utf8').trim();
  }

  setActive(release_id: string): void {
    this.manifest(release_id);
    writeFileSync(join(this.dir, 'ACTIVE'), release_id + '\n');
  }

  setStatus(release_id: string, status: ReleaseManifest['status']): ReleaseManifest {
    const m = this.manifest(release_id);
    m.status = status;
    writeFileSync(this.releasePath(release_id), JSON.stringify(m, null, 2) + '\n');
    return m;
  }

  nextReleaseId(): string {
    return `r${this.list().length + 1}`;
  }

  latestVersion(level: ComponentLevel): number {
    const d = join(this.dir, 'components', level);
    if (!existsSync(d)) return 0;
    return Math.max(0, ...readdirSync(d).map((n) => Number(n.replace(/^v/, ''))).filter((n) => Number.isFinite(n)));
  }

  /** Copy an accepted candidate bundle in as the next immutable version of a component. */
  addComponent(level: ComponentLevel, fromDir: string): { version: number; content_hash: Sha256 } {
    const version = this.latestVersion(level) + 1;
    const dest = this.componentDir(level, version);
    mkdirSync(dest, { recursive: true });
    cpSync(fromDir, dest, { recursive: true });
    return { version, content_hash: hashDir(dest) };
  }

  /** Read a component's definition file (`<level>.json`) for a release. */
  load<T>(release_id: string, level: ComponentLevel): T {
    const m = this.manifest(release_id);
    const dir = this.componentDir(level, m.components[level].version);
    return JSON.parse(readFileSync(join(dir, `${level}.json`), 'utf8')) as T;
  }

  /** Confirm stored component bytes still match the hashes pinned in the manifest. */
  verify(release_id: string): { ok: boolean; mismatches: string[] } {
    const m = this.manifest(release_id);
    const mismatches: string[] = [];
    for (const level of LEVELS) {
      const actual = hashDir(this.componentDir(level, m.components[level].version));
      if (actual !== m.components[level].content_hash) mismatches.push(`${level} v${m.components[level].version}`);
    }
    return { ok: mismatches.length === 0, mismatches };
  }
}
