# Live improvement run: live-improve-2

**LIVE MODEL AUTHOR.** A model wrote each candidate from development cases only. The review workload is SYNTHETIC, and the release gate judged each candidate by executing it on held-out cases — no model took part in the judging.

Observed first: 13 verified failures in 40 development reviews (accuracy 68%).

## Round 1

- Author: claude-opus-5-5; 81 s; 9 turns; 1 run(s) of the development check; 8285 output tokens; list-price cost estimate 0.3222 USD (not billing).
- Tool uses refused by the worker harness: 1 (Bash: cd /home/user/swarm_2/var/live-improve-2/candidates/live-author/ws; node -e ' const cs=require("./dev-cases.js).
- Hypothesis (the author's): If the change-review skill also compares contract_before and contract_after field by field (recursing into nested objects and array items) and blocks consumer-breaking differences, then breaking changes that are currently approved will be sent back with the correct field named. That covers removed or renamed fields, type changes, newly required fields, removed enum values, unit or format changes and tightened constraints. Doc-only changes and added optional fields should still be approved. Measured result: development accuracy went from about 0.675 on the observed sample to 1.0 on the 60 dev cases, with 0 of 38 breaking changes approved and 0 of 22 safe changes blocked.
- Development accuracy: 1 claimed by the author; 1 measured by the gate on a different development sample.
- **Gate decision: reject.** Rejected: safe changes are not blocked failed. Share of safe changes blocked: candidate 10.0%, incumbent 0.0%; allowed margin 5.0%.
- Held-out accuracy on holdout-A: 0.5 → 0.9625 (difference 0.4625, 95% interval 0.3375 to 0.5875, n=80).
- Share of breaking changes approved: 0.8 → 0.
- Share of safe changes blocked: 0 → 0.1.

## Round 2 (revision)

- Author: claude-opus-5-5; 93 s; 18 turns; 3 run(s) of the development check; 9389 output tokens; list-price cost estimate 0.3963 USD (not billing).
- Tool uses refused by the worker harness: 2 (Bash: cd /home/user/swarm_2/var/live-improve-2/candidates/live-author/ws; node -e ' const c=require("./dev-cases.jso; Bash: node -e ' const c=require("./dev-cases.json");for(const x of c){if(x.label.defect_class!=="type_changed"&&x.la).
- Hypothesis (the author's): If interface_compat blocks only changes that stop a previously valid value or record from being valid (a type swapped or narrowed, a field removed or renamed, a field made required, an enum value removed, a constraint tightened, a oneOf/anyOf alternative dropped) and makes widening changes advisory (type widened or made nullable, a required field made optional, an explicit type added that the existing enum already satisfies, a format added, oneOf/anyOf alternatives added, a draft-4 exclusive flag relaxed), then the share of held-out safe changes blocked will drop from 0.10 to 0.05 or less (no more than incumbent + 0.05). Breaking changes approved should stay near 0, because every breaking class seen in dev and in observed failures (type swap, field removed, field renamed, required added, enum value removed) is still blocked.
- Development accuracy: 1 claimed by the author; 1 measured by the gate on a different development sample.
- **Gate decision: accept.** Accepted: accuracy improved by 0.5125 against the incumbent (95% interval 0.4 to 0.625) with every hard gate passed.
- Held-out accuracy on holdout-B: 0.4875 → 1 (difference 0.5125, 95% interval 0.4 to 0.625, n=80).
- Share of breaking changes approved: 0.9535 → 0.
- Share of safe changes blocked: 0 → 0.

Canary on fresh cases: **retained**. Active release afterwards: r2.

Held-out sets used by this line of work: holdout-A, holdout-B. A revision is never scored on a set its lineage has already seen results for.
Final decision: **accept**. Active release afterwards: r2.

Isolation: candidate CODE was executed by the gate in mode `enforced`. The AUTHOR was confined by the worker harness only (file tools scoped to its workspace), not by the operating system; it ran as the operator user.

Files: `summary.json`; per round `receipt.md` / `receipt.json` and `authored/` (the check the model wrote, its report, and the task it was given); `release-manifest.md` if a release was created.
