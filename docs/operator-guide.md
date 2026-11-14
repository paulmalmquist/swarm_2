# Operator guide

Everything is run from the repository root with Node 22.18 or later. There is nothing to install
or build. `swarm2` below means `node src/cli.ts` (or `npm run swarm2 --`).

State lives in one directory: `./var` by default, or `--home DIR`, or `SWARM2_HOME`.

## Run it

```
swarm2 init                                   # install the baseline release (r1) in this state directory
swarm2 ingest fixtures/scenarios/shared-capability/requests.json
swarm2 proposals                              # overlapping requests nominated as one mission
swarm2 submit --scenario shared-capability --title "Shared dataset-health capability" \
       --objective "One policy-driven view of dataset health." \
       --requests syn-req-001,syn-req-002,syn-req-003,syn-req-004
swarm2 run                                    # coordinate until the work is idle
swarm2 serve --run                            # or: interface + coordinator in one process (http://127.0.0.1:4317/)
```

A mission runs on deterministic, labeled fixtures unless it is submitted with `--live` **and** the
operator has set `SWARM2_LIVE=1`. With live execution, workers are real `claude -p` processes; the
steps a scenario marks as templates stay scripted and are recorded as fixture attempts.

## Inspect it

```
swarm2 status [--mission ID]      # progress, how the work was executed, whose action is next, spend
swarm2 attention                  # decisions and drafts waiting for a person
swarm2 evidence <mission> --md    # the review packet
swarm2 serve                      # Planning / Doing / Reviewing / Evolution, read-only without --run
swarm2 gate status                # isolation mode, integrity of rules and records, releases, canaries
swarm2 gate experiments           # every experiment and its decision
swarm2 gate receipt <id> --md     # one improvement receipt
swarm2 evolve portfolio           # open problems, hypotheses, what the improvement policy has done
swarm2 connectors                 # what is connected and what each real integration needs
swarm2 export [--dir D]           # analytical history as newline-delimited JSON
```

In the interface, the header always shows where the data came from (live or fixture), the active
release, the isolation mode and the model calls in flight. Detail is behind drill-down: mission →
swarm → task → artifact → verification.

## Decide

```
swarm2 decide <decision_id> <option> --rationale "..."
swarm2 priority <mission> <n>
swarm2 revise <mission> <artifact_key> <file> --reason "..."    # change an upstream artifact; dependents are invalidated
swarm2 cancel <mission> --reason "..."
```

The organization never sends, merges, deploys or commits you to anything. Approving a review
packet records your decision and marks the draft approved; the merge itself stays with your
existing protected path.

## Stop it

| To stop | Do |
|---|---|
| Everything, now | `swarm2 stop` — writes a `STOP` file in the state directory. Every coordinator on that directory stops dispatching, stops its workers and exits. `swarm2 resume` removes it |
| One mission | `swarm2 cancel <mission> --reason "..."` — descendants are cancelled, workers stopped, reservations released, artifacts kept |
| A coordinator process | Ctrl-C or kill it. Nothing is lost: the next `swarm2 run` fences in-flight attempts, stops orphaned workers and continues from the store |
| Live model use | Unset `SWARM2_LIVE`. Live tasks block with an operator next-action; nothing falls back to fixtures |
| An improvement in trial | `swarm2 gate canary rollback <canary> --reason "..."` |

## Limits

Defaults are the development profile in `src/config.ts`. Override them in `swarm2.config.json`
(`{"limits": {...}}`) or by environment. Agents cannot raise any of them.

| Limit | Default | Override |
|---|---|---|
| Concurrent model calls | 12 | `SWARM2_MAX_CONCURRENT` |
| Delegated layers | 3 | `SWARM2_MAX_DEPTH` |
| Worker invocations per mission | 200 (mission budget: 120) | config, or the mission's budget |
| Wall-clock per mission | 60 minutes of running time | config (`max_wall_ms`). Past it the mission stops and asks you: cancel, extend by one period, or hold |
| Tokens / estimated cost | per mission budget (4,000,000 tokens, 20 USD list-price estimate) | the mission's budget |
| Retries / repair attempts per task | 2 / 2 | config, or the execution definitions |
| Reserved for verification / recovery / completion | 15% / 10% / 5% | config |
| Experiment allocation | 250,000 experiment units in total | `protected/policy.json` (a rule change: yours to decide) |
| Lease / heartbeat | 15 s / 2 s | `SWARM2_LEASE_MS` |
| Minimum time for one live attempt | 5 minutes | config (`live_attempt_floor_ms`) |
| Live execution | off | `SWARM2_LIVE=1` |

Cost figures are list-price estimates reported by the client. They are not billing, and under a
subscription there is no per-call bill. A model worker that is stopped before it finishes reports
no usage at all; `swarm2 status` then counts it under `unreported_usage_attempts`, and the review
packet and the interface say that tokens and cost are lower bounds.

## Improvement work

```
swarm2 evolve observe                 # record failures of the current skill on development work
swarm2 evolve report --class C --count N --note "..."   # record unverified reports (never counted as verified)
swarm2 evolve step [--budget N]       # ask the improvement policy in force for one step and carry it out
swarm2 evolve campaign [--budget N]   # repeat until the policy stops or the budget is spent
swarm2 evolve candidates              # hand-authored candidates
swarm2 evolve run <candidate> [--revises <experiment>]   # put one candidate to the release gate
swarm2 gate canary start <release> [--max-missions N]
swarm2 gate canary observe <canary>
swarm2 gate canary retain <canary>    # the release becomes the default for future work only
swarm2 gate canary rollback <canary> --reason "..."
swarm2 gate dependents <release>      # missions, artifacts and memories that rest on a release
```

Only the gate creates a release. An accepted release is not the default until its canary is
retained. Missions already running keep the release they started with.

Changing the promotion rules (`protected/policy.json`, the held-out cases, the scoring code) is
your decision, not an experiment's. After an authorized edit, reseal the protected store; until
then the gate reports the store as changed and refuses to decide.

## Demonstrations and tests

```
npm test                 # 62 tests, about two minutes
npm run demo:all         # demonstrations A–I on fixtures; rewrites evidence/
npm run check:report     # the figures the documents quote, rebuilt from evidence/
npm run demo:a           # one demonstration (a … i)
npm run typecheck
```

Each demonstration writes `evidence/demo-<x>/README.md` with what was checked and what was observed,
plus the receipts, manifests and timelines it produced. Injected faults and synthetic data are
labeled in every bundle.

## When something looks wrong

| Symptom | Meaning | Action |
|---|---|---|
| A task is `blocked` with `provider_unavailable` or `provider_rate_limited` | Live execution is off, or the account's usage limit was reached | Enable live execution or wait for capacity; the task resumes by itself. No retry was consumed |
| A mission is `blocked` | A task exhausted its retries or repairs, a worker reported it cannot proceed, or a limit was reached | `swarm2 attention` shows the decision waiting for you. `retry` sends the work back once more, and your rationale is given to the next attempt as guidance |
| A result sits in `verifying` | Its check threw, or a coordinator stopped mid-check | Nothing to do: the next pass checks it again, and after three errors the result goes back to its author with the reason |
| A decision says discovery left a request out | The analysis judged an authorized request to be a separate need; the mission is continuing without it | `separate` returns the request to intake for its own mission; `stop` cancels this one |
| `gate status` says the store changed | A protected file differs from its sealed digest | Find out who edited it. Restore it, or reseal after an authorized change |
| An accepted release cannot enter a canary (`stale_parent`) | Another release became the default after this one was qualified | Rebuild the candidate on the current release and evaluate it again |
| A held-out set is `REMAINING` | Every registered set has been revealed to that lineage or reached its exposure cap | New held-out cases are needed before another decision |
| The interface shows `source unavailable` | That value could not be read | Read the reason shown; nothing is filled in with zeros |

## What it does not do

It does not send messages, create tickets, merge code or deploy. It has no connection to Slack,
Jira, GitLab, BigQuery, dbt, Power BI, OpenMetadata, Dreamcatcher, Strongbox or Paul OS; those are
ports with stated requirements ([integration.md](integration.md)). The interface is a loopback
development tool, not an authenticated service.
