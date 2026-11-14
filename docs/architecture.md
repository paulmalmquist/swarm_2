# Architecture

swarm_2 is an execution and improvement layer that sits beneath an existing chief of staff.
The chief of staff decides what matters and speaks for Paul. swarm_2 turns an authorized objective
into coordinated work, verifies the result, and uses the outcome to change how later work is done.

This document describes what is built. What ran, and with what result, is in
[evidence-report.md](evidence-report.md).

## 1. Three responsibilities

| Responsibility | Owns | Where it lives |
|---|---|---|
| Chief of staff | Business priorities, human interaction, commitments, every outward-facing statement | Outside swarm_2. Reached through `ChiefOfStaffPort` (`src/cos/port.ts`) |
| Mission coordination | Turning an objective into a work graph, assigning owners, managing dependencies, integrating results | Agents propose plans (`PlanProposal`); `src/coordination/` validates and materializes them |
| Runtime control | Task transitions, leases, budgets, access scopes, artifact versions, cancellation, promotion rules | Ordinary code: `src/kernel/`, `src/gate/`. No model output can change this state directly |

The rule that holds the design together: **agents propose, the runtime decides.** A plan, a result,
a claim that a criterion is met, a candidate improvement — each is a proposal. The runtime validates
it against the contract and records the outcome. Activity, confident prose, valid JSON or agreement
between agents never satisfies an acceptance criterion; only a passing verification for the current
generation of the work does (`Kernel.acceptTask`).

## 2. The smallest durable shape

```
 chief of staff ──commands──▶ ChiefOfStaffPort ──▶ kernel (SQLite, one file per state directory)
        ▲                                             │  missions · tasks · leases · budgets
        │ decisions, drafts, review packets           │  artifacts · evidence · decisions · events
        │                                             ▼
   review interface ◀── read models ◀──────── coordinator (a loop over durable state)
   (/v1/os/swarm)                                     │ dispatches one OS process per attempt
                                                      ▼
                                   workers: model (claude -p) or labeled fixture
                                   coding workers each get a git worktree
                                                      │ results come back under a fencing token
                                                      ▼
                               integration queue ──▶ independent verification ──▶ review packet

 protected store (separate directory, separate SQLite file, other OS user where available)
   release registry · promotion policy · held-out cases · evaluation ledger · canaries
   candidates are evaluated here in a sandbox; nothing they run can write here
```

- **One language, no services.** TypeScript on Node 22 run directly (type stripping), zero runtime
  dependencies, `node:sqlite` for state, `git` for workspaces, `node:http` for the interface.
- **State is the coordination medium.** Agents do not talk to each other to find out what is
  happening; they read contracts and pinned inputs, and write results. Messages exist for
  questions and decisions, are capped in size, and are counted.
- **A state directory is the unit of deployment.** `SWARM2_HOME` (default `./var`) holds the
  operational database, artifacts, workspaces and the protected store. Copying it copies the
  organization's memory; deleting it resets everything.

## 3. Records

Every record is typed in `src/contracts/types.ts`. The ones that carry the design:

| Record | What it is for |
|---|---|
| `Mission` | An authorized objective: accountable human, authority envelope, budget, the release it is pinned to, and whether it runs on live models or fixtures |
| `DelegationContract` | The one contract used for an individual agent and for a whole swarm: owner, objective, measurable acceptance criteria, inputs pinned to exact artifact versions, dependencies and assumptions, permitted tools/data/actions and write scope, resource reservation, deadline and stopping conditions, required outputs, verification method, escalation path, cancellation behaviour |
| `Task` | A node of the work graph carrying a contract. A swarm is a container task; its children start only after it is leased, and it settles from them |
| `Attempt` | One execution of a task by one worker process: provider, requested and actual model, usage, workspace, fencing token |
| `Artifact` / `ArtifactVersion` | Versioned outputs with content hash, producer, the inputs they were built on and a currency flag |
| `Evidence` / `Verification` | What was observed, by whom, about which artifact version; and the verdict on one acceptance criterion |
| `Handoff` | Artifact version, acceptance evidence, remaining uncertainty and the next owner. The original owner stays responsible until the handoff is accepted |
| `Message` / `Decision` / `Draft` | Scoped communication; conflicts and choices with a named owner and bounded rounds; outward-facing text that only a person can approve |
| `Memory` / `Observation` / `Outcome` | Reusable knowledge with provenance, scope, freshness and invalidation; verified failures and suspected causes; what a mission actually achieved |
| `Experiment` / `ImprovementReceipt` / `ReleaseManifest` / `CanaryRecord` | The improvement lifecycle (section 7) |
| `RunEvent` | Append-only, hash-chained log of everything above. The interface and the demonstrations read from it |

## 4. Coordination as an executable contract

**Ownership.** A task has one accountable owner. A worker holds a lease that it extends by
heartbeat. When a lease expires the task is reclaimed and the attempt number in its fencing token
(`g<generation>a<attempt>`) advances. A result presented under an old token is rejected, so a
worker presumed dead cannot overwrite the attempt that replaced it.

**Dependencies.** Prerequisite and `verifies` edges are explicit; a cycle is refused when a plan is
validated. Inputs are pinned to exact artifact versions when a task is leased. When an upstream
artifact changes, every consumer is marked `needs_revalidation`, its generation advances, and
in-flight work on the old version is fenced. Before paying to redo a task the runtime checks
whether everything it was built on is byte-identical to before; if so the verified result is reused.

**Plans are proposals.** A swarm lead may propose subordinate teams (`anchor: 'own_swarm'`). The
runtime refuses a plan with a cycle, overlapping write scopes, a task without acceptance criteria,
a team without a purpose, owner, budget, deliverable or stopping condition, authority wider than
the parent's, or shares that exceed what the parent holds.

**Integration.** Each coding attempt works in its own git worktree on its own branch. The runtime
commits the pinned inputs first, so the worker's changes are exactly what follows, and re-checks
the write scope from git afterwards. Accepted workstreams enter a serialized integration queue; the
combined result is tested at the boundary and then verified by a different swarm in a clean
checkout, with an acceptance suite the delivery workers never see.

**Conflicts and communication.** A conflict goes to a named decision owner with options, evidence
and consequences; debate has a round limit and then resolves or escalates. Messages are routed by
topic to owners and subscribers, capped at 2,000 bytes (larger results travel as artifact
references), persisted, and counted per mission.

**Duplicates.** Requests are clustered by overlap while each stakeholder's need is kept as its own
record tied to its own acceptance criterion. A verified investigation with matching scope and
freshness is reused across missions instead of repeated. Commands carry idempotency keys: a repeat
is a no-op, and a reused key with a different body is quarantined.

**Recovery.** Everything needed to resume is in the store. A new coordinator fences attempts left
in flight, stops orphaned worker processes, frees their call slots and continues. Nothing is
reconstructed from chat history.

**External effects.** An effect outside the store is recorded as an intent first. If its outcome is
unknown the target is asked what happened before anything is retried (`performEffect` in
`src/connectors/ports.ts`). Each adapter states the guarantee it actually provides.

**Cancellation.** Cancelling a mission or a task cancels its descendants, stops their workers,
releases their reservations and keeps the artifacts already produced.

## 5. Resources and authority

- A mission's budget is a tree. A child reserves from its parent atomically and can never hold
  more than the parent has; spawning an agent creates no spending authority. Unspent reservations
  return to the parent when work settles. A retry its task cannot pay for draws on the recovery
  reserve by moving allowance from one account to another; a move is never recorded as spending.
  Consumption and limits are both reconciled against the ledger.
- Capacity is set aside before delivery starts: 15% for verification, 10% for recovery, 5% for
  completion, and up to 10% for exploration. Delivery cannot spend them.
- Limits are operator configuration (`src/config.ts`, `swarm2.config.json`, environment): 12
  concurrent model calls, three delegated layers, worker invocations, wall-clock time, tokens and
  estimated cost where measurable, retries and repair attempts, and the experiment allocation.
  A mission that runs past its wall-clock ceiling stops for a person, who alone can extend it.
- Authority only narrows on the way down. Outward actions — external communication, new
  commitments, protected merges, shared deployments, authority changes — are never delegable.
  The system prepares a draft with its supporting context; a person approves it; sending or
  merging stays with the existing protected path.
- Usage is recorded as what it is: provider-reported tokens, a list-price cost *estimate*
  (never called billing), runtime-measured wall time, or a declared fixture value. A model worker
  stopped before it finishes reports nothing: the attempt is charged the invocation and the time
  the runtime measured, its tokens and cost stay unknown, and every total that includes it is
  shown as a lower bound.

## 6. Memory

The store keeps a queryable chain: mission → task → evidence → decision → artifact → verification →
outcome → experiment → release (`lineage()` in `src/memory/memory.ts`, and the drill-down in the
interface).

Every memory has a kind (fact, interpretation, procedure, failed approach, decision, correction
from a person, candidate skill), an origin (business or agent), a certainty (verified, suspected,
untested), a scope, provenance down to artifact versions, a freshness date and an invalidation
path. What a fixture mission taught is classed as synthetic evidence and never counts as empirical.
A procedure stays untested, and a candidate skill stays a candidate, until it has been used again
in independently accepted work. A failed approach is recorded with its context and is reconsidered
— as a suspicion, not as settled — when the environment it failed in changes.

Workers receive a small context packet selected by scope and text match. Context selection is part
of the execution definitions, so it is versioned and can be changed by an experiment.

## 7. Three levels of self-improvement

Three components are versioned independently and combined into a release manifest (`r1`, `r2`, …):

| Level | Definition | What a candidate can change | How a candidate is judged |
|---|---|---|---|
| 1. Execution | `definitions/execution/` | Agent instructions, skills and their executable checks, context selection, model routing, retry limits | Held-out review cases, executed in a sandbox |
| 2. Coordination | `definitions/coordination/` | Which swarms form, interface agreements, reviewer assignment, integration, escalation, reuse, budget shares | Complete missions run on the real runtime under each policy, then an oracle |
| 3. Evolution | `definitions/evolution/` | The improvement policy itself: how problems are ranked, whether to pilot, when to stop | Equal budgets on unseen failure episodes; independently validated benefit and the cost of failed experiments |

Level 3 is not only tested in a testbed. The policy of the release in force decides the
organization's real improvement work (`src/evolution/portfolio.ts`): it reads the recorded
observations and the state of every hypothesis and chooses the next step — build, pilot on observed
cases, submit to the release gate, or stop. Replacing the evolution component changes what the
organization works on next.

### Lifecycle

1. Observe outcomes and record a specific problem (`Observation`, verified or suspected).
2. State a falsifiable hypothesis. 3. Name the component and version being changed.
4. State the expected benefit and possible regressions.
5. Freeze the protocol and budget — before the candidate exists.
6. Build the candidate in an isolated workspace. 7. Run development checks.
8. Evaluate against the incumbent and the fixed original baseline.
9. Accept, reject, or record "no demonstrated improvement".
10. Try an accepted release in a bounded canary. 11. Retain it or roll it back.
12. Record the result — including a failed approach — for later experiments.

Every decided experiment has an **improvement receipt**: the problem and its observations, the
hypothesis, the parent version and exact file changes, the evaluation version and workload, every
attempt and its resource use, differences with intervals, known regressions and limitations, the
decision and its justification, the new release manifest if any, and the rollback target.

### The release gate

- **Authorship and promotion are separate.** An author builds a bundle and submits it. The gate
  (`src/gate/gate.ts`) takes custody of a copy, evaluates it, and alone can create a release.
- **The protected store** holds the promotion policy, held-out cases, scoring code, the evaluation
  ledger (hash-chained) and the release pointer. Candidate code runs in a sandbox process under an
  unprivileged OS user with Node's permission model as a second layer. The gate reports which of
  three modes the host actually provides — `enforced`, `seatbelt` or `procedural` — in every receipt.
- **A candidate cannot change the rules it is judged by.** Static screening refuses code that uses
  file, process, network or dynamic-code capabilities. A proposal to change the rules becomes a
  decision for the chief of staff and is applied by nobody else.
- **Hard gates are not compensable.** No saving or speed-up outweighs a failed one (required steps
  present, no forbidden capabilities, no more escaped defects, no regression against the original
  baseline, enough samples, held-out cases unseen by this lineage).
- **Held-out sets are a spent resource.** A lineage is never scored twice on the same set; a
  revision after a revealed result gets a different one, and the first becomes development data.
- **Simplification is rewarded.** A candidate declared as a simplification is accepted when quality
  is no worse and cost falls.
- **Weak evidence is reported as such.** The decision is `inconclusive` — "no demonstrated
  improvement" — when the interval includes zero, and the candidate and result are kept.

### Releases, canaries, rollback

A mission is pinned to its release when it is submitted and keeps it. An accepted release is not
the default: it can enter one bounded canary (a limited number of development missions, or, for an
improvement policy, a bounded stretch of improvement work), is observed on fresh cases, and is then
retained or rolled back. Rollback restores the prior release, lists the missions, artifacts and
memories that depended on the withdrawn one, marks them, and opens a decision about any mission
still in flight. A release qualified against a parent that is no longer active is refused, so one
promotion cannot silently discard another.

## 8. Real execution and fixtures stay distinguishable

- Every API response is a provenance envelope: `source` is `live`, `fixture`, `simulation`,
  `replay` or `unavailable` with a reason. An unavailable value is never rendered as zero.
- Every attempt records its provider. A live mission can contain steps that stay scripted (a
  policy template, a reference document); they run on the fixture provider and are recorded as
  fixture attempts. Progress reports count model attempts, scripted attempts and runtime steps.
- Release manifests carry an evidence basis. A release qualified on fixtures says so.
- Live model execution is off unless the operator sets `SWARM2_LIVE=1`. A capacity error blocks
  the task for the operator and never falls back to another provider or to a fixture.

## 9. Source map

| Path | Contents |
|---|---|
| `src/contracts/` | Typed records and definition schemas |
| `src/store/` | SQLite documents, append-only hash-chained events, idempotency |
| `src/kernel/` | Leases, fencing, dependencies, invalidation, budgets, authority, comms, intake |
| `src/coordination/` | Plan validation, the coordinator loop, integration, verification, review packet, metrics |
| `src/providers/` | `fixture` (real child processes running scripts) and `claude-cli` (real model workers) |
| `src/workspace/` | Git worktrees, integration branch, clean verification checkouts |
| `src/cos/` | The chief-of-staff port and its local implementation |
| `src/connectors/` | Connector ports, reconciled external effects, analytical export |
| `src/memory/` | Memory ingestion, retrieval, invalidation, reconsideration, lineage |
| `src/gate/` | Release registry, sandbox, release gate, canary and rollback |
| `src/evolution/` | Candidate builder, improvement loop, hypothesis portfolio, mission episodes, improvement arena, receipts |
| `src/api/`, `src/ui/` | Read models, HTTP API under `/v1/os/swarm`, the review interface |
| `definitions/` | Versioned execution, coordination and evolution definitions (baseline `v1`) |
| `protected/` | Promotion policy, held-out cases and scoring code (the source the protected store is sealed from) |
| `fixtures/` | Synthetic scenarios, the fixture application, development cases, candidate library |
| `demos/`, `evidence/` | Demonstrations A–I and the evidence bundles they write |
| `tests/` | Coordination, recovery, isolation, rollback, limits, connectors, portfolio and API tests |
