# Demonstration E — Rejection of a candidate that omits required verification

> DETERMINISTIC FIXTURE EVALUATION — executable validators on synthetic cases; no model was run

A candidate proposes to halve review cost by dropping the step that checks for tests. It declares itself a simplification. The gate probes each step that may not be omitted with a case whose answer is known.

## What was checked

| Claim | Observed | Result |
|---|---|---|
| The candidate really is cheaper | steps per review 2 → 1 | held |
| It is cheaper because it omits a required verification step | The candidate omits a step that may not be omitted: tests_present. A probe case with a known answer was not caught. | held |
| The release gate rejects it; a hard gate cannot be outscored | Rejected: required verification steps are performed; no more defects escape; no cumulative regression against the original baseline failed. The candidate omits a step that may not be omitted: tests_present. A probe case with a known answer was not caught. | held |
| The omission has a measured consequence on held-out cases | share of breaking changes approved 0.8 → 1 | held |
| The rejected candidate and its result are preserved | candidate ad307fc1e0c2ada6 kept in custody; receipt rcpt_0mwgq2bb1a81633df03 | held |

Files in this folder: `fast-review-rejected.receipt.json`, `fast-review-rejected.receipt.md`.

Reproduce with `npm run demo:e`. Run time 370 ms.
