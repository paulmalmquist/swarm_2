import { rng } from './util.ts';

/**
 * Small, dependency-free statistics used by the release gate.
 * Every function is deterministic for a given seed so a decision can be re-derived exactly.
 */

export function mean(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Wilson score interval for a binomial proportion (95% by default). */
export function wilson(successes: number, n: number, z = 1.959964): { p: number; lo: number; hi: number } {
  if (n === 0) return { p: NaN, lo: 0, hi: 1 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, lo: Math.max(0, (centre - margin) / denom), hi: Math.min(1, (centre + margin) / denom) };
}

/**
 * Paired bootstrap confidence interval for the mean of per-case differences.
 * Pairs are resampled together, which is what makes the comparison "on the same cases".
 */
export function pairedBootstrapCI(
  diffs: number[],
  opts: { seed: number; iterations?: number; alpha?: number } = { seed: 1 },
): { mean: number; lo: number; hi: number; n: number } {
  const n = diffs.length;
  if (n === 0) return { mean: NaN, lo: NaN, hi: NaN, n };
  const iterations = opts.iterations ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rand = rng(opts.seed);
  const means: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += diffs[Math.floor(rand() * n)]!;
    means[i] = s / n;
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.max(0, Math.floor((alpha / 2) * iterations))]!;
  const hi = means[Math.min(iterations - 1, Math.ceil((1 - alpha / 2) * iterations) - 1)]!;
  return { mean: mean(diffs), lo, hi, n };
}

/** Exact two-sided sign test on paired outcomes (ties dropped). Returns the p-value. */
export function signTest(diffs: number[]): { wins: number; losses: number; ties: number; p: number } {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const d of diffs) {
    if (d > 0) wins++;
    else if (d < 0) losses++;
    else ties++;
  }
  const n = wins + losses;
  if (n === 0) return { wins, losses, ties, p: 1 };
  const k = Math.min(wins, losses);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binom(n, i);
  const p = Math.min(1, (2 * tail) / Math.pow(2, n));
  return { wins, losses, ties, p };
}

function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

export function round(n: number | null, digits = 4): number | null {
  if (n === null || Number.isNaN(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}
