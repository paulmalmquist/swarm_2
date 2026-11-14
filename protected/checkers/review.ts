// PROTECTED — scoring rules for the review workload. Candidates cannot read or change this.
import type { ReviewLabel, ReviewOutput } from '../../fixtures/evolution/review-cases.ts';

export interface CaseScore {
  correct: boolean;
  escaped_defect: boolean;
  false_alarm: boolean;
  named_field: boolean | null;
  /** Severity-weighted cost of this outcome: an escaped defect costs its severity, a false alarm costs one. */
  harm: number;
}

export function scoreReview(label: ReviewLabel, out: ReviewOutput | null): CaseScore {
  if (!out || (out.verdict !== 'approve' && out.verdict !== 'request_changes')) {
    // No usable answer is scored as the worst outcome for the case.
    return { correct: false, escaped_defect: label.should_block, false_alarm: !label.should_block, named_field: label.field ? false : null, harm: label.should_block ? label.severity : 1 };
  }
  const blocked = out.verdict === 'request_changes';
  const blocking = (out.findings ?? []).filter((f) => f.severity === 'blocking');
  const named = label.field === null ? null : blocking.some((f) => f.field === label.field || (f.field ?? '').endsWith(`.${label.field}`));
  const escaped = label.should_block && !blocked;
  const false_alarm = !label.should_block && blocked;
  // Blocking for the wrong reason does not count: the finding must name the affected field.
  const correct = label.should_block ? blocked && named !== false : !blocked;
  return { correct, escaped_defect: escaped, false_alarm, named_field: named, harm: escaped ? label.severity : false_alarm ? 1 : label.should_block && !correct ? label.severity / 2 : 0 };
}
