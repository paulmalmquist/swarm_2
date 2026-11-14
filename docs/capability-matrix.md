# Capability matrix

Recorded 2026-11-14 from inside the build container. Each row is something that was actually
exercised, with the evidence, its limitation, and the implementation choice it led to.
"Not available" rows state the exact integration requirement instead of assuming a connector exists.

## Runtime and delegation

| Capability | Verified | Evidence | Limitation | Chosen implementation |
|---|---|---|---|---|
| Node runs TypeScript directly | Yes | Node v22.23.4 executed a `.ts` file and `node --test` on `.ts` with no build step | Only erasable syntax (no enums, namespaces, parameter properties) | TypeScript orchestration with zero runtime dependencies; `tsc --noEmit` for type checks |
| Transactional store | Yes | `node:sqlite` (SQLite 3.53.4): WAL, FTS5, and `RAISE(ABORT)` triggers all worked | Driver is flagged experimental by Node; single-writer | SQLite is authoritative for ownership, task state, handoffs and approvals; artifact bytes live in files |
| Application-managed model workers | Yes | `claude -p --output-format json` (Claude Code 2.1.325) returned real completions; `--json-schema` put the validated object in `structured_output`; `stream-json` emitted events usable as heartbeats | Subject to the account usage limit below | `claude-cli` provider adapter; one OS process per attempt, leased and fenced by the runtime |
| Model access and routing | Yes | Aliases resolved to `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-2` (reported in `modelUsage`) | Alias targets can change; a fallback can serve a different model | Requested and actual model are both recorded per attempt |
| Cost and usage reporting | Partly | Result JSON carries token counts and `total_cost_usd` with `costBasis: "list"` | Official docs call `total_cost_usd` "a client-side estimate, not authoritative billing data"; a subscription has no per-call bill | Tokens are stored as measured; cost is stored as `list_price_estimate`; billing is never synthesized |
| Account usage limit | Hit | At 16:05 UTC nested workers and delegated agents returned HTTP 429 "You've hit your 5-hour limit · resets 8:50pm (UTC)" (`is_error: true`, `api_error_status: 429`, exit 1) | Shared by this session, delegated agents and nested workers. Live execution was unavailable for the rest of the window | The provider classifies this as `rate_limited`: the task blocks with an operator next-action, burns no retry, and there is no automatic fallback to another provider or to fixtures |
| Ordinary subagents (Agent tool) | Yes | Four were launched during discovery | `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` here, so subagents cannot spawn subagents (docs default is three layers). Results return only to the parent | Used for the build itself, not as the durable substrate. The hierarchy lives in swarm_2's own task model |
| Native Agent Teams | Not usable | Docs: experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), interactive sessions only, one team per session, no nested teams, in-process teammates not restored on resume | Cannot run under `-p` or the SDK | Adapter boundary only (`Provider` interface); not relied on |
| Independent sessions | Partly | `--resume`, `--session-id`, `--fork-session` exist; cloud session tools exist in this environment | `--bg` is rejected with `-p`; cross-session messaging is plain text over a local socket | Session ids are recorded per attempt so a worker conversation can be resumed; not used for coordination state |
| Git worktrees | Yes | `git worktree add` (git 2.43.0); a worker wrote into its worktree | — | One worktree and branch per coding attempt; serialized integration queue |

## Isolation

| Capability | Verified | Evidence | Limitation | Chosen implementation |
|---|---|---|---|---|
| OS user separation | Yes | Running as root, `setpriv --reuid=65534` produced a process that got `Permission denied` reading and writing a `0700` root-owned directory and could still write its own workspace | Needs root (or sudo) on the host. Not available to an unprivileged operator account | Candidate code runs under an unprivileged uid; the protected store is root-owned `0700`. Reported as `enforced` |
| Node permission model | Yes | `node --permission --allow-fs-read/--allow-fs-write` denied out-of-scope reads, writes and `child_process` with `ERR_ACCESS_DENIED` | Node documents it as a seat belt, not a defence against malicious code | Second layer for candidate execution; the only layer when uid separation is unavailable (`seatbelt`) |
| Tool allow-lists confine model workers | **No** | A worker started with `--permission-mode dontAsk --allowedTools Read Write Edit` wrote a file **outside** its working directory | A bare `Write` allow rule is not path-scoped. Path-scoped rules and `--restricted` were not verified (the probe hit the usage limit) | Model workers are treated as procedurally separated unless run under the unprivileged uid; the protected store does not depend on worker cooperation |
| Model worker under an unprivileged uid | Unverified | The `claude` binary starts as uid 65534 (`--version`); an authenticated call was not tested (usage limit) | Needs credentials readable by that uid | Documented integration requirement; candidate *code execution* is uid-separated regardless |

## Connectors and incumbent systems

| System | Reachable here | Evidence | Chosen implementation |
|---|---|---|---|
| Slack, Jira/Atlassian, Linear, Notion, Asana, PagerDuty | No | MCP connectors failed: proxy answered `403` to CONNECT | Typed ports with clearly labeled local implementations reading synthetic fixtures |
| GitLab, dbt, Power BI, OpenMetadata, Dreamcatcher, Strongbox | No | No CLI, connector or credential present | Ports only; exact requirements listed in `docs/integration.md` |
| BigQuery | Not attempted | `bq` CLI is installed; no project or dataset was authorized for this task | Analytical export is written as local JSONL in the shape a warehouse load would take |
| Paul OS (the chief of staff application) | No | Its source is a work-machine checkout (`C:\Projects\paul-os`) referenced by the incumbent repos, not present here | `ChiefOfStaffPort` with a local implementation; contracts follow Paul OS conventions found in the repos below |
| `paulos-surfaces` | Read | Cloned read-only: provenance envelope, `/v1/os/...` route registry, promotion and program schemas | API responses carry `source` and never turn an unavailable value into zero; routes live under `/v1/os/swarm` |
| `agent-promotion-control-plane` | Read | Cloned read-only: hard gates are non-compensable, events append-only, idempotency keys, leases, no force-promote route | Gate vocabulary (`HARD_GATE`/`WEIGHTED`, `PASSED`/`FAILED`/`REMAINING`), `policyHash` and `evaluationSnapshotHash` on every decision |
| `swarm-court` | Read | Cloned read-only: "ball in court", explicit ownership, handoff acceptance, budget stance, task-contract and invalidation schemas | Ownership from explicit records only; pending handoffs keep the original owner; `needs_revalidation` and generations; live execution off by default and fail-closed |
| `swarm_receipt`, `swam_assumption_trial_ledger`, `swarm_counterfactual` | Read | Cloned read-only: command envelope, outcome contracts, Wilson-bound trials, "synthetic never satisfies empirical" | Command envelope `{command, data, actor, key, expected_version}`; evidence is classed empirical or synthetic; fixture evidence never certifies live use |
| `swarm_design` | Not read | The repository-attach call for it was declined by the session's permission classifier | Left alone |

## Delegation mechanisms compared

| Mechanism | Nesting | Shared state | Resumable | Headless | Role in swarm_2 |
|---|---|---|---|---|---|
| Subagents | Three layers by default; one here | None; results return to the parent | By agent id | Yes | Build-time help only |
| Agent Teams | No nested teams; one per session | Task list and mailbox on disk | Not for in-process teammates | No | Not used |
| Independent sessions | Per session | None | Yes, by transcript | `-p` yes, `--bg` no | Session id kept per attempt |
| Application-managed workers | Whatever the application models | The application's own store | Yes, by the application | Yes | **The substrate**: every node of the hierarchy is a durable task; a worker process is leased per attempt |
