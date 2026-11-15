import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { globMatch, SwarmError } from '../lib/util.ts';

export interface FileChange { path: string; content: string | null }
const MAX_BYTES = 1024 * 1024;

function safePath(dir: string, path: string): string {
  const parts = path.split('/');
  if (!path || path.includes('\\') || path.includes('\0') || parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.')))
    throw new SwarmError('unsafe_path', `Invalid worker file path: ${path}`);
  let current = dir;
  for (const part of parts) {
    current = join(current, part);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new SwarmError('unsafe_path', `Symlink in worker path: ${path}`);
  }
  return current;
}

/** The model receives bounded plain text, and never runs tools in the coordinator's account. */
export function workspaceSnapshot(dir: string): string {
  const files: FileChange[] = [];
  let bytes = 0;
  const visit = (prefix: string): void => {
    for (const name of readdirSync(join(dir, prefix)).sort()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const path = prefix ? `${prefix}/${name}` : name;
      const full = safePath(dir, path);
      const st = lstatSync(full);
      if (st.isDirectory()) { visit(path); continue; }
      if (!st.isFile() || st.size > MAX_BYTES || (bytes += st.size) > MAX_BYTES) throw new SwarmError('workspace_too_large', 'Workspace exceeds the bounded model snapshot');
      files.push({ path, content: readFileSync(full, 'utf8') });
    }
  };
  visit('');
  return JSON.stringify(files);
}

/** Validate the entire proposal before touching any file. Null content means delete. */
export function applyFileChanges(dir: string, changes: FileChange[], scope: string[]): void {
  if (!Array.isArray(changes) || changes.length > 100) throw new SwarmError('invalid_patch', 'At most 100 file changes are allowed');
  let bytes = 0;
  const seen = new Set<string>();
  const checked = changes.map((c) => {
    if (!c || typeof c.path !== 'string' || (c.content !== null && typeof c.content !== 'string')) throw new SwarmError('invalid_patch', 'Each file change needs a path and string or null content');
    const full = safePath(dir, c.path);
    if ([...seen].some((p) => p === c.path || p.startsWith(c.path + '/') || c.path.startsWith(p + '/')) || !scope.some((g) => globMatch(g, c.path))) throw new SwarmError('write_scope_violation', c.path);
    seen.add(c.path);
    if (existsSync(full) && !lstatSync(full).isFile()) throw new SwarmError('unsafe_path', c.path);
    bytes += Buffer.byteLength(c.content ?? '');
    if (bytes > MAX_BYTES) throw new SwarmError('invalid_patch', 'Patch exceeds 1 MiB');
    return { ...c, full };
  });
  for (const c of checked) {
    if (c.content === null) rmSync(c.full, { force: true });
    else { mkdirSync(dirname(c.full), { recursive: true }); writeFileSync(c.full, c.content); }
  }
}
