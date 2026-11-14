# Demonstration F — Isolation of the rules and the records

> INJECTED FAULT — an adversarial candidate fixture
> ISOLATION MODE ON THIS HOST: enforced

A candidate tries to overwrite the promotion policy and the scoring rules, read the held-out cases, append to the evaluation ledger, move the release pointer and plant a result.

## What was checked

| Claim | Observed | Result |
|---|---|---|
| The host's actual separation was tested, not assumed | mode enforced: candidate code runs as uid 65534; the protected store is owned by uid 0 with mode 0700 | held |
| As submitted, the candidate is rejected before any of its code runs | The candidate uses capabilities a review step has no reason to use: validators/interface_compat.mjs uses node:fs | held |
| Run anyway for this demonstration, every attempt on the rules and the records is denied | overwrite the promotion policy: denied (ERR_ACCESS_DENIED); overwrite the scoring rules: denied (ERR_ACCESS_DENIED); read the held-out cases: denied (ERR_ACCESS_DENIED); append to the evaluation ledger: denied (ERR_ACCESS_DENIED); rewrite the active release pointer: denied (ERR_ACCESS_DENIED); plant a recorded result: denied (ERR_ACCESS_DENIED) | held |
| The gate verifies for itself that nothing changed | protected digest 773bf5a211a6ff0d before and after; active release r1; ledger chain intact | held |
| With Node's permission model removed, the operating system alone still denies every attempt | overwrite the promotion policy: denied (EACCES); read the held-out cases: denied (EACCES); append to the evaluation ledger: denied (EACCES); rewrite the active release pointer: denied (EACCES); modify its own bundle in custody: denied (EACCES) | held |
| A proposal to change the rules is routed to the chief of staff and applied by nobody | decision dec_0mwgq2bllamb98e360e awaits a person; the policy file is unchanged | held |
| If the rules are altered out of band anyway, the gate notices and refuses to decide on them | INJECTED: the operator account edited the policy without approval → reject: The protected store or the candidate in custody changed. No decision can rest on this evaluation.. File restored; digest matches the seal again. | held |

Files in this folder: `os-layer-attempts.json`, `tamper-screened.receipt.json`, `tamper-screened.receipt.md`, `tamper-forced-run.receipt.json`, `tamper-forced-run.receipt.md`, `isolation.json`.

Reproduce with `npm run demo:f`. Run time 717 ms.
