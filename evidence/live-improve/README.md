# Live improvement run: live-improve

**LIVE MODEL AUTHOR.** A model wrote the candidate from development cases only. The review workload is SYNTHETIC, and the release gate judged the candidate by executing it on held-out cases — no model took part in the judging.

- Observed: 13 verified failures in 40 development reviews (accuracy 68%).
- Author: claude-opus-5-5; 94 s; 10 turns; 1 runs of the development check; 9558 output tokens; list-price cost estimate 0.4188 USD (not billing).
- Tool uses refused by the worker harness: 1 (Bash: cd /home/user/swarm_2/var/live-improve/candidates/live-author/ws; node -e '
const cs=require("./dev-cases.json");const m={};for(const {case:c,label:l} of cs){const k=l.defect_class+"|"+l.should_block;m[k]=(m[k]||0)+1}console.log(cs.length,m).
- Hypothesis (the author's): If the change-review skill also runs interface_compat (a recursive structural diff of contract_before vs contract_after that blocks removed/renamed fields, type changes, unit/format/constraint changes, enum value removals, and requiredness changes while treating annotation-only changes and new optional fields as safe), then breaking interface changes (type_changed, field_removed, field_renamed, required_added, enum_value_removed and similar unseen kinds such as unit or nested-field changes) will be sent back with the correct dot-path field, raising accuracy above the current ~0.675 without increasing blocked safe changes; this is falsified if held-out accuracy does not rise, any breaking change is approved, or safe changes are blocked beyond the margin.
- Development accuracy: 1 claimed by the author; 1 measured by the gate on a different development sample.
- **Gate decision: reject.** Rejected: safe changes are not blocked failed. Share of safe changes blocked: candidate 10.0%, incumbent 0.0%; allowed margin 5.0%.
- Held-out accuracy on holdout-A: 0.5 → 0.9625 (difference 0.4625, 95% interval 0.3375 to 0.5875, n=80).
- harm per review: 2.5 → 0.0375
- escaped defect rate: 0.8 → 0
- false alarm rate: 0 → 0.1
- steps per review: 2 → 3
- wall ms per review: 0.141 → 0.193
- No canary: nothing was accepted.

Isolation: candidate CODE was executed by the gate in mode `enforced`. The AUTHOR was confined by the worker harness only (file tools scoped to its workspace), not by the operating system; it ran as the operator user.

Files: `summary.json`, `receipt.md` / `receipt.json`, `authored/` (the check the model wrote, its report, and the task it was given), `release-manifest.md` if a release was created.
