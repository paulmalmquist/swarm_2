# Integration

swarm_2 touches the outside world only through adapters. This document gives each boundary, the
contract on our side of it, what is implemented today, and the exact requirement for the real
integration. Nothing here assumes a connector or credential exists.

Check the current state at any time:

```
node src/cli.ts connectors        # what is connected, what each real integration needs
```

## 1. Chief of staff

The chief of staff keeps priorities, attention, continuity and commitments. swarm_2 exposes one
small typed interface to it, `ChiefOfStaffPort` in `src/cos/port.ts`:

| Call | Purpose |
|---|---|
| `ingestRequests({requests})` | Record raw requests; nominate overlapping ones as a proposed mission while keeping each stakeholder's need distinct |
| `proposals()` | Proposed missions with their basis |
| `submitMission({title, objective, priority, request_ids, scenario, provider_mode, budget, authorization, accountable_human})` | Authorize an objective. Returns the mission, pinned to a release |
| `changePriority({mission_id, priority})` | Reorder work |
| `cancelMission({mission_id, reason})` | Cancel a mission and everything under it; artifacts are kept |
| `inspectProgress(mission_id?)` | Status, how the work was executed, whose action is next, blockers, spend against budget |
| `attention()` | Everything that needs a person: decisions the organization may not make, and drafts awaiting review |
| `resolveDecision({decision_id, chosen, rationale})` | Record a decision and apply its effect |
| `reviewDraft({draft_id, approve, note})` | Approve or reject an outward-facing draft. Approval is recorded; the system sends nothing |
| `retrieveEvidence(mission_id)` | The review packet (JSON and readable), with the event count and chain check |
| `recordCorrection({mission_id, task_key, correction, failure_class})` | A correction from a person becomes a verified observation and a memory |

Conventions, taken from the incumbent repositories that were readable:

- **Command envelope** `{command, data, actor, key, expected_version}`. `key` is an idempotency
  key: repeating a command returns the original result, and reusing a key with a different body is
  refused and quarantined.
- **Provenance envelope** on every response: `source` is `live`, `fixture`, `simulation`, `replay`
  or `unavailable` (with `reason`). An unavailable value is never shown as zero.
- **Routes** live under `/v1/os/swarm/…`, matching the `/v1/os/…` registry used by Paul OS surfaces.

The same port is reachable three ways:

| Transport | How |
|---|---|
| In process | `new LocalChiefOfStaff(runtime)` |
| HTTP | `POST /v1/os/swarm/commands` with header `x-swarm2-token` (loopback only; a per-process token); read models by `GET` |
| Command line | `swarm2 ingest / proposals / submit / status / attention / decide / evidence / priority / cancel` |

**Implemented today:** `LocalChiefOfStaff`, a local implementation of the port operating directly
on the runtime. It is a stand-in, labeled as such.

**Requirement for the real integration:** Paul OS is the chief of staff and its Attention surface
is the only place that mutates. Its source was not reachable from the build environment (it is
referenced as a work-machine checkout). To connect it: have Paul OS call the HTTP commands above
(or import the port), and render every item from `attention()` in Attention. swarm_2 never needs
to call Paul OS; it only answers. If Paul OS should be notified rather than poll, add an outbound
adapter that posts `attention()` changes through `performEffect` so delivery is reconciled.

What stays with the chief of staff, by construction: external communications, new commitments,
protected merges, shared deployments and authority changes are not delegable to any agent. The
organization produces a draft with its supporting context and a decision request, and stops.

## 2. Model providers

`Provider` in `src/providers/provider.ts` starts one worker for one attempt and reports its result.

| Provider | What it is | Guarantee |
|---|---|---|
| `fixture` | A real child process that runs a scenario script and submits under its own fencing token. Supports injected faults (slow, crash, hang, stale submit, named defects) | Deterministic and labeled. Zero model calls. Never represents model work |
| `claude-cli` | A real model worker: `claude -p` in headless mode with a JSON schema for its result, one process per attempt | At most one accepted result per fencing token. A retry reruns the model; outputs are not replayed. Usage is provider-reported; cost is a list-price estimate, not billing |

Model routing (which model for which swarm) is part of the execution definitions and so can be
changed by an experiment. The requested model and the model that actually served are both recorded.

Live execution is off unless the operator sets `SWARM2_LIVE=1`. A capacity error (for example an
account usage limit) blocks the task with an operator next-action, burns no retry, and does not
fall back to another provider or to a fixture.

**Requirement for another provider** (the Agent SDK, a hosted API, a different vendor): implement
`Provider.start(request, hooks)`; call `hooks.onHeartbeat` while the worker is alive; return a
`WorkResult` with the structured output and measured usage. Nothing else changes.

How the runtime maps onto Claude Code's delegation features is recorded, with evidence, in
[capability-matrix.md](capability-matrix.md). In short: the hierarchy lives in swarm_2's own task
model and each node is executed by an application-managed worker. Subagents, Agent Teams and
independent sessions are not used as the durable substrate, because none of them gives nested,
resumable, shared state under headless execution.

## 3. Connectors

Ports are in `src/connectors/ports.ts`.

| System | Port | Today | Exact requirement |
|---|---|---|---|
| Slack | `RequestSourcePort` | Local fixture reading synthetic requests. The Slack connector was refused by the egress proxy (403) | Implement `fetch()` against the approved Slack connector; map each message to `{id, source, stakeholder, team, text, received_at}`; apply the channel allow-list and data classification before any text reaches a model |
| Jira | `RequestSourcePort` | Local fixture. The Atlassian connector was refused by the egress proxy (403) | Implement `fetch()`; use the issue key as the request id so redelivery is idempotent. Creating or transitioning issues is an outward action and stays with the chief of staff |
| GitLab | `CodeHostPort` (not implemented) | No route or credential | A read adapter for merge requests and diffs, and a draft-only adapter that turns an approved draft into a merge request through the existing protected path. swarm_2 never merges |
| BigQuery | `WarehousePort` | Local newline-delimited JSON files (`swarm2 export`). No project or dataset was authorized | Implement `load()` as a load job per table with the idempotency key as the job id, so a retried load cannot duplicate rows. Row shapes are in `export/schema.json` |
| dbt | `CatalogPort` (not implemented) | — | Read-only model and metric definitions, so acceptance criteria can cite certified metric versions |
| Power BI | `CatalogPort` (not implemented) | — | Read-only dataset and report lineage, so a mission can name the dashboards a change affects |
| OpenMetadata | `CatalogPort` (not implemented) | — | Read-only ownership, freshness and schema versions; these replace the synthetic dataset observations in the fixture application |
| Dreamcatcher | `AppHostPort` (not implemented) | — | App manifest, route registration, theme and access policy, so the review interface mounts inside the existing shell |
| Strongbox | `SecretsPort` (not implemented) | — | Short-lived credentials handed to adapters at call time. swarm_2 stores no secrets and passes none to workers |

**Effects outside the store.** Any adapter that changes something external goes through
`performEffect`: the intent is recorded first; if the outcome is unknown (a timeout after the call
may have landed), the target is asked what happened before any retry; a confirmed effect is never
repeated. The guarantee is at-least-once intent with reconciliation — not exactly-once — and each
adapter states its own.

**Analytical history.** Operational scheduling stays in the transactional store. `swarm2 export`
writes missions, tasks, attempts, verifications, outcomes, observations, experiments and experiment
metrics as newline-delimited JSON, one file per table, with nulls for anything not measured.
Repeating an export at the same point adds no rows.

## 4. Review interface

`swarm2 serve` serves a static interface and JSON read models from the same store the coordinator
writes. It follows the Planning / Doing / Reviewing structure with an Evolution view, and reads only
persisted events and state.

| Route | Content |
|---|---|
| `GET /v1/os/swarm/overview` | Counts, the active release, isolation mode, model calls in flight, kill-switch state |
| `GET /v1/os/swarm/planning` | Requests, proposed missions, priorities, decisions needed |
| `GET /v1/os/swarm/doing` | Active missions, owners, current artifacts, critical path, blockers, next action |
| `GET /v1/os/swarm/ownership?mission=` | The ownership graph: whose action or decision is next |
| `GET /v1/os/swarm/reviewing` | Completed work with context, exact changes, acceptance evidence, concerns, the decision requested |
| `GET /v1/os/swarm/evolution` | Organization and release, experiments, lineage, receipts, canaries, rollbacks, the hypothesis portfolio |
| `GET /v1/os/swarm/metrics` | Outcome metrics and diagnostic activity |
| `GET /v1/os/swarm/missions/:id`, `/tasks/:id`, `/artifacts/:id`, `/receipts/:id` | Drill-down |
| `GET /v1/os/swarm/events?after=&mission=` | The event log |
| `POST /v1/os/swarm/commands` | The chief-of-staff commands |

It binds to loopback and checks a per-process token on every mutation. It is not an authenticated
shared service: do not expose it through a proxy or a tunnel. Mounting it for other people needs the
access policy of the host shell (Dreamcatcher) in front of it.

## 5. Isolation requirements on the host

Generated code requires Linux namespace isolation (bubblewrap + util-linux). The runtime mounts
only its explicit input workspace read-only, provides ephemeral scratch space, and supplies no
network or host environment. An unavailable sandbox blocks execution. Model authors return bounded
file proposals with tools disabled. See [hardening.md](hardening.md) for prerequisites and limits.

The operator and provider CLI are trusted. Held-out generators remain in the repository, so an
author with independent repo access can see them. Real adapters still require source ACLs and
scoped credentials; no production integration is implied by passing fixture tests.
