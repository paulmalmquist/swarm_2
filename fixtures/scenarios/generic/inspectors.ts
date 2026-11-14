import type { Inspector } from '../../../src/runtime.ts';

export const inspectors: Record<string, Inspector> = {
  /** Passes when the artifact's `quality` is at least the number after the colon in the check target (`key:3`). */
  quality_at_least: ({ artifacts, criterion }) => {
    const [key, min] = (criterion.check?.target ?? ':0').split(':');
    try {
      const q = Number((JSON.parse(artifacts[key ?? ''] ?? '{}') as { quality?: number }).quality ?? 0);
      return { ok: q >= Number(min), details: `quality ${q} against a minimum of ${min}` };
    } catch {
      return { ok: false, details: `${key} is not valid JSON` };
    }
  },
};
