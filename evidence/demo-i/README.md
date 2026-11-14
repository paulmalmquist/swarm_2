# Demonstration I — The improvement policy in force runs the organization's own improvement work

> DETERMINISTIC FIXTURE PROVIDER — scripted workers in real processes; no model was run
> SYNTHETIC DATA — every request, team, dataset and value is invented
> SYNTHETIC — the review workload, the 30 unverified complaints and the library of candidate fixes (some deliberately flawed)
> One campaign per policy: a case study, not a statistical comparison

Demonstration D compares two improvement policies statistically in a testbed. This one shows the policy of the release in force doing its real job: reading the organization's recorded observations and deciding what to build, pilot, submit to the release gate, or stop.
Control (frequency-first): 1. build style_strict → built on r1 (20 units); 2. submit style_strict → inconclusive on holdout-A (281 units); 3. build guard_removed_toplevel → built on r1 (40 units); 4. submit guard_removed_toplevel → accept on holdout-B; r2 is qualified for a canary (281 units); 5. build guard_type_strict → built on r1 (30 units); 6. build guard_required → built on r1 (30 units); 7. build guard_enum → built on r1 (30 units); 8. stop → stopped: no affordable step remains (0 units).
Trial (expected-value, in a canary): 1. build guard_removed_toplevel → built on r1 (40 units); 2. pilot guard_removed_toplevel → pilot on 12 observed cases: fixed 6 of 6 targeted failures, broke 0 working cases (12 units); 3. submit guard_removed_toplevel → accept on holdout-A; r3 is qualified for a canary (281 units); 4. build guard_type_strict → built on r1 (30 units); 5. pilot guard_type_strict → pilot on 12 observed cases: fixed 3 of 3 targeted failures, broke 0 working cases (12 units); 6. submit guard_type_strict → reject on holdout-B (281 units); 7. stop → stopped: no remaining step is worth its cost (0 units).
Units that did not end in an accepted change — control: 301 on experiments not accepted plus 90 on builds never submitted; trial: 323 plus 0. Each policy got 1 and 1 fix(es) accepted.

## What was checked

| Claim | Observed | Result |
|---|---|---|
| The organization keeps a portfolio of hypotheses built from its own recorded observations | 13 verified review failures in 5 classes, plus 30 unverified reports of one complaint; 8 hypotheses | held |
| The policy of the release in force decides each step, inside a bounded budget | r1's policy (frequency-first) took 8 decisions and used 712 of 900 units | held |
| The replacement policy first has to pass the release gate | accept: Accepted: validated_benefit improved by 12.6167 against the incumbent (95% interval 0.4167 to 25.4333) with every hard gate passed. | held |
| During the canary the new policy decides, and the default has not changed | 7 decisions under canary can_0mwgs5xa31pbe5deea2; active release still r1 | held |
| Replacing the policy changes what the organization works on | frequency-first began with style_strict; expected-value began with guard_removed_toplevel and piloted 2 times before submitting | held |
| Every submission from either policy was decided by the same release gate | control: 1 accepted, style_strict (inconclusive) not accepted; trial: 1 accepted, guard_type_strict (rejected) not accepted | held |
| Each approach that did not pass is recorded so it is not repeated blindly | [suspected] Adding the style_strict check to change review (built on r1) was inconclusive at the release gate: No demonstr… \| [verified] Adding the guard_type_strict check to change review (built on r1) was rejected at the release gate: Rejected: … | held |
| The canary is observed, then retained | actions the runtime had to refuse: 0; r2 is now the default for future work | held |
| A fix qualified against the old default is not promoted over the new one | Release r3 was qualified against r1, but r2 is now active. Rebuild the candidate on r2 and evaluate it again. All 8 hypotheses were reopened to be rebuilt on r2. | held |

Files in this folder: `portfolio-control.json`, `portfolio-trial.json`, `comparison.json`, `expected-value-policy.receipt.json`, `expected-value-policy.receipt.md`, `control-guard_removed_toplevel-accepted.receipt.json`, `control-guard_removed_toplevel-accepted.receipt.md`, `control-style_strict-inconclusive.receipt.json`, `control-style_strict-inconclusive.receipt.md`, `trial-guard_removed_toplevel-accepted.receipt.json`, `trial-guard_removed_toplevel-accepted.receipt.md`, `trial-guard_type_strict-rejected.receipt.json`, `trial-guard_type_strict-rejected.receipt.md`.

Reproduce with `npm run demo:i`. Run time 24076 ms.
