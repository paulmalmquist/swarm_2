// DETERMINISTIC FIXTURE behaviors for the generic scenario. `params.fixture` lets a test shape the result.
import type { Behavior } from '../../../src/providers/fixture-worker.ts';

interface Hint {
  content?: string;
  quality?: number;
  fail_attempts?: number;
  status?: 'completed' | 'blocked' | 'failed';
}

export const behaviors: Record<string, Behavior> = {
  '*': (ctx) => {
    const hint = (ctx.params.fixture ?? {}) as Hint;
    if ((hint.fail_attempts ?? 0) >= ctx.attempt) {
      return { status: 'failed', summary: `fixture failure on attempt ${ctx.attempt}`, artifacts: [], evidence: [], criteria_claims: [], remaining_uncertainty: [], questions: [], proposals: [] };
    }
    const artifacts = ctx.task.contract.required_outputs
      .filter((o) => o.kind !== 'code')
      .map((o) => ({ key: o.key, kind: o.kind, media_type: 'application/json', content: JSON.stringify({ fixture: true, task: ctx.task.key, quality: hint.quality ?? 1, text: hint.content ?? `Fixture result for: ${ctx.task.title}` }) }));
    return { status: hint.status ?? 'completed', summary: `Fixture result for ${ctx.task.key}`, artifacts, evidence: [], criteria_claims: [], remaining_uncertainty: [], questions: [], proposals: [] };
  },
};
