# Demonstration D — Improvement of the improvement process

> SIMULATION — a synthetic improvement arena; policies and fixes are real executable code, the failure distribution is invented
> Both policies and the arena were written by the same author. The result describes this testbed.

Two improvement policies run improvement campaigns. The incumbent works on whatever is reported most often. The candidate values a problem by verified failures times severity per unit of cost, pilots a built fix on observed cases before paying for a held-out evaluation, drops a fix whose pilot breaks something, and stops when nothing is worth its cost.
Each policy gets the same budget on the same thirty unseen episodes. Every fix a policy submits is judged on held-out cases by the release gate's rule; the campaign's worth is then measured on fresh cases.

## What was checked

| Claim | Observed | Result |
|---|---|---|
| The candidate changes the evolution system's own behaviour and is versioned as such | evolution v1 → candidate; changed evolution.json, policy.mjs | held |
| Old and new policies get equal budgets and the same unseen failure episodes | 30 episodes from held-out set arena-A; budget 420 units each; mean spent 411.3333 (incumbent) and 372.8 (candidate) | held |
| What is measured is independently validated improvement, not the policy's own claims | validated benefit 165 → 177.6167 per 100 reviews (difference 12.6167, 95% interval 0.4167 to 25.4333); sign test: 11 better, 2 worse, 17 same, p=0.02246 | held |
| The cost of unsuccessful experiments is counted | budget spent on fixes that failed: 207.3333 → 120.0667 units per campaign (difference -87.2667, 95% interval -113.3333 to -62.1333) | held |
| The decision follows the frozen rule, whichever way it falls | accept: Accepted: validated_benefit improved by 12.6167 against the incumbent (95% interval 0.4167 to 25.4333) with every hard gate passed. | held |
| The sensitivity check and known regressions are reported, favourable or not | without the unverified complaint class: difference 5.6167 (95% interval -5.15 to 16.65). In 2 of 30 episodes the candidate policy delivered less validated benefit than the incumbent Without the unverified complaint class the advantage is not demonstrated (difference 5.6167, 95% interval -5.15 to 16.65) | held |

Files in this folder: `expected-value-policy.receipt.json`, `expected-value-policy.receipt.md`, `release-manifests.json`, `ledger.json`, `campaign-tallies.json`.

Reproduce with `npm run demo:d`. Run time 22131 ms.
