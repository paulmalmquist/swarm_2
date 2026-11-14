# Progress notes

Durable working notes so the build survives a context reset. Newest state first.

## Current state

- **Increment 2 (durable runtime) — kernel done.** Contracts, SQLite store, kernel (tasks, leases with
  fencing tokens, dependency graph, invalidation, hierarchical budgets, authority narrowing,
  cancellation, recovery), scoped messaging, decisions, handoffs, request intake. 17 kernel tests pass.
- Next: provider adapters (fixture worker process, `claude -p`), worktrees and integration queue,
  the coordinator loop, then the first end-to-end mission.

## Commands that work now

```bash
npm install            # dev-only: typescript, @types/node
npm run typecheck
npm test
```

## Build order (from the brief) and status

1. Inspect environment, define integration boundaries, establish repository — **done** (`docs/capability-matrix.md`)
2. Durable mission/task runtime and one provider adapter — kernel done, adapters next
3. One mission from intake through verified artifact and review packet
4. Cross-swarm coordination, integration, failure recovery
5. First improvement loop and protected evaluation boundary
6. Experiments on the improvement process itself
7. Review interface, demonstrations, handoff

## Decisions taken

- TypeScript on Node ≥ 22.18, no runtime dependencies, SQLite via `node:sqlite`. Matches the
  incumbent "portable, no packages" convention and Paul OS's TypeScript contracts.
- The hierarchy is swarm_2's own durable task model. A worker is an OS process leased per attempt
  (`claude -p` for live work, a labeled fixture worker otherwise). Native subagents and Agent Teams
  are not the substrate (see the capability matrix for why).
- Fencing token = `g<generation>a<attempt>`. Upstream change bumps the generation; each lease bumps the attempt.
- Inputs are pinned to exact artifact versions when a task is leased, not when it is planned.
- Live model execution is off by default and fail-closed; a provider capacity error blocks the task
  with an operator next-action and never falls back to another provider.
- Promotion vocabulary follows `agent-promotion-control-plane`; hard gates are non-compensable.

## Open decisions

- None blocking.

## Environment facts worth knowing

- The account's 5-hour usage limit was hit at 16:05 UTC on 2026-11-14 (resets 20:50 UTC). Delegated
  agents and nested `claude -p` workers return HTTP 429 until then. Live demonstrations wait for it.
- Slack/Jira/Linear/Notion connectors are blocked by the egress proxy (403). No GitLab/dbt/Power BI/
  OpenMetadata/Dreamcatcher/Strongbox access exists here.
- Incumbent repos cloned read-only next to this one: `agent-promotion-control-plane`, `paulos-surfaces`,
  and under `paulmalmquist/`: `swarm-court`, `swarm_receipt`, `swam_assumption_trial_ledger`,
  `swarm_counterfactual`, `engineering_intelligence`.
