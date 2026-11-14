// PROTECTED — held-out episode seeds for the improvement arena.
// A policy author may run the arena on any other seed; these are only ever used by the gate.

export const ARENA_SETS = ['arena-A', 'arena-B', 'arena-C'];

export function episodeSeeds(set: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${set}-episode-${String(i).padStart(2, '0')}`);
}
