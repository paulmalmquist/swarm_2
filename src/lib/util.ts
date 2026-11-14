import { createHash, randomBytes } from 'node:crypto';
import type { Iso, ResourceAmounts, Sha256 } from '../contracts/types.ts';

// ───────── canonical JSON and hashing ─────────
// Hashes prove captured bytes, not truth or semantic equivalence.

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

export function sha256(data: string | Uint8Array): Sha256 {
  return createHash('sha256').update(data).digest('hex');
}

export function hashOf(value: unknown): Sha256 {
  return sha256(canonicalize(value));
}

// ───────── clock ─────────

export interface Clock {
  now(): number;
  iso(): Iso;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
};

/** A controllable clock for deterministic tests. */
export class ManualClock implements Clock {
  private t: number;
  constructor(start = Date.parse('2026-11-14T00:00:00.000Z')) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  iso(): Iso {
    return new Date(this.t).toISOString();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export function isoPlus(clock: Clock, ms: number): Iso {
  return new Date(clock.now() + ms).toISOString();
}

// ───────── ids ─────────

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 1296;
  const t = Date.now().toString(36).padStart(9, '0');
  const c = counter.toString(36).padStart(2, '0');
  const r = randomBytes(4).toString('hex');
  return `${prefix}_${t}${c}${r}`;
}

// ───────── seeded randomness (mulberry32) ─────────

export function seedFrom(text: string): number {
  return parseInt(sha256(text).slice(0, 8), 16) >>> 0;
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────── resource arithmetic ─────────

const KEYS: (keyof ResourceAmounts)[] = ['model_calls', 'worker_invocations', 'tokens', 'cost_usd_est', 'wall_ms'];

export function amounts(partial: Partial<ResourceAmounts> = {}): ResourceAmounts {
  return {
    model_calls: partial.model_calls ?? 0,
    worker_invocations: partial.worker_invocations ?? 0,
    tokens: partial.tokens ?? 0,
    cost_usd_est: partial.cost_usd_est ?? 0,
    wall_ms: partial.wall_ms ?? 0,
  };
}

export function addAmounts(a: ResourceAmounts, b: ResourceAmounts): ResourceAmounts {
  const out = amounts();
  for (const k of KEYS) out[k] = round6(a[k] + b[k]);
  return out;
}

export function subAmounts(a: ResourceAmounts, b: ResourceAmounts): ResourceAmounts {
  const out = amounts();
  for (const k of KEYS) out[k] = round6(a[k] - b[k]);
  return out;
}

export function scaleAmounts(a: ResourceAmounts, f: number): ResourceAmounts {
  const out = amounts();
  for (const k of KEYS) out[k] = k === 'cost_usd_est' ? round6(a[k] * f) : Math.floor(a[k] * f);
  return out;
}

/** True when every dimension of `need` fits inside `have`. */
export function fits(need: ResourceAmounts, have: ResourceAmounts): boolean {
  return KEYS.every((k) => need[k] <= have[k] + 1e-9);
}

export function firstShortfall(need: ResourceAmounts, have: ResourceAmounts): string | null {
  for (const k of KEYS) if (need[k] > have[k] + 1e-9) return `${k}: need ${need[k]}, available ${have[k]}`;
  return null;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// ───────── small helpers ─────────

export class SwarmError extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function assert(cond: unknown, code: string, message: string, details: Record<string, unknown> = {}): asserts cond {
  if (!cond) throw new SwarmError(code, message, details);
}

/** Returns the first entry of `child` not covered by `parent` (exact match, or a parent prefix ending in `*`/`**`). */
export function coveredBy(child: string[], parent: string[]): string | null {
  for (const c of child) {
    const ok = parent.some((p) => p === c || (p.endsWith('*') && c.startsWith(p.replace(/\*+$/, ''))));
    if (!ok) return c;
  }
  return null;
}

/** Minimal glob for write scopes: `**` any depth, `*` within a segment. */
export function globMatch(pattern: string, path: string): boolean {
  const re =
    '^' +
    pattern
      .split('**')
      .map((part) =>
        part
          .split('*')
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*'),
      )
      .join('.*') +
    '$';
  return new RegExp(re).test(path);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
