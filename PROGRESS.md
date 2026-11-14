# Progress notes

## Manufacturing view — 2026-11-14

The primary diagram now follows hardware configuration, change impact, build effectivity,
evidence applicability and engineering/quality decisions. It is explicitly a target workflow;
manufacturing domain contracts and integrations remain to be built. The existing infrastructure
view is preserved in `docs/runtime-overview.svg`. Runtime controls are unchanged.

## Hardening update — 2026-11-14

PR #1 merged at `15299b9`. The `codex/harden-swarm-runtime` branch adds isolation, complete-run
verification, scoped promotion, transactional review, current outcomes, checked memory sources,
request revisions and effect idempotency. Local validation: 61 tests; nine demos; 75/75 demo checks.
Receipts: `evidence/hardening/`. Diagram: `docs/architecture-overview.svg`.
Current limits and operating prerequisites: `docs/hardening.md`. The revised live worker path has
not been exercised with a model. Older progress and live receipts below are historical.

Durable notes so the work survives a context reset. Read this first, then `docs/handoff.md`.

## State

All seven increments of the build order are complete and pushed on branch
`claude/swarm-2-agent-org-ffiy5j` (draft pull request #1).

| Increment | State | Where to look |
|---|---|---|
| 1. Environment, integration boundaries, repository | Done | `docs/capability-matrix.md`, `docs/integration.md` |
| 2. Durable mission/task runtime and one provider | Done | `src/kernel/`, `src/store/`, `src/providers/` |
| 3. One mission from intake to verified artifact and review packet | Done | `tests/mission.test.ts`, demonstration A |
| 4. Cross-swarm coordination, integration, failure recovery | Done | `src/coordination/`, demonstration B |
| 5. First improvement loop and protected evaluation boundary | Done | `src/gate/`, `src/evolution/loop.ts`, demonstrations C, E, F, G |
| 6. Experiments on the improvement process itself | Done | `src/evolution/arena.ts`, `src/evolution/portfolio.ts`, demonstrations D, I |
| 7. Review interface, demonstrations, handoff | Done | `src/ui/`, `demos/`, `evidence/`, `docs/` |

Beyond the seven: targeted comparisons against simpler configurations (demonstration H), live runs
on real model workers (`evidence/live-*`), connector ports and analytical export.

## Commands that work today

```
npm run typecheck
npm test                           # 49 tests, about two minutes
npm run demo:all                   # demonstrations A–I on fixtures; rewrites evidence/
npm run demo:a … demo:i            # one demonstration
SWARM2_LIVE=1 npm run demo:live    # cross-swarm mission on real model workers (uses the account)
SWARM2_LIVE=1 node demos/live-improve.ts   # a real model as candidate author
node src/cli.ts help               # every operator command
node src/cli.ts serve --run        # interface + coordinator, http://127.0.0.1:4317/
```

## Decisions made, and why

- **TypeScript on Node 22 with no runtime dependencies; SQLite through `node:sqlite`.** No incumbent
  stack was reachable, and this is the smallest thing that gives transactions, leases and a durable log.
- **The hierarchy lives in our own task model; workers are application-managed processes.**
  Subagents are one layer deep here, Agent Teams are interactive-only, and neither gives shared
  resumable state under headless execution (`docs/capability-matrix.md`).
- **A swarm is a container task.** One delegation contract serves an agent and a swarm.
- **Agents propose, the runtime decides.** Plans, results, claims and candidates are all proposals.
- **The release gate is separate code with a separate store**, and reports the isolation mode it
  actually got. Candidate code runs as another OS user where the host allows it.
- **Held-out sets are a spent resource**, tracked per candidate lineage.
- **A release qualified against a parent that is no longer active is refused.** Stricter than
  necessary for independent levels, but it cannot silently drop a promotion (see open items).
- **In a live mission, planning templates stay scripted** and are recorded as fixture attempts.
  The work graph comes from the versioned coordination policy, not from a model.

## Open decisions for Paul

1. **Which chief-of-staff transport to wire first** — Paul OS calling the HTTP commands, or
   importing the port in process. Nothing in swarm_2 depends on the choice.
2. **A worker credential.** Model workers cannot authenticate as an unprivileged user with the
   operator's credential, and should not be given it. A scoped credential (through Strongbox) would
   make worker isolation OS-enforced instead of harness-enforced.
3. **Who owns the acceptance tests.** In the fixture scenario they are pre-authored. In live use
   they must be derived from the agreed criteria by the verification swarm, or supplied by a
   person; the first live run showed what happens when a hidden test is stricter than its criterion.
4. **The promotion rules** in `protected/policy.json` (margins, sample sizes, the experiment
   allocation) are first guesses. Changing them is a decision, not an experiment.

## Not done, in order of value

1. A verification swarm that writes acceptance tests from criteria in live missions.
2. Live plan proposals: let a model propose the work graph, validated by the runtime
   (validation exists; the live schema deliberately does not offer the field yet).
3. Real connectors (Paul OS, Slack, Jira, GitLab, BigQuery). Ports and requirements exist.
4. Coordination-level and improvement-policy experiments on live missions. Today they run on
   fixture episodes and a synthetic arena.
5. Component-level rebase: re-qualifying an accepted change against a new default without
   spending another held-out set when the evaluated component is untouched.
6. Running improvement work as an Evolution-swarm mission inside the runtime (it is driven by the
   gate and the portfolio today, with its own ledger and allocation).

## Next executable step

`SWARM2_LIVE=1 npm run demo:live`, then read `evidence/live-a/README.md`. If the mission stops for
a person, `node src/cli.ts --home var/live-a attention` shows the decision, and
`node src/cli.ts --home var/live-a decide <id> retry --rationale "<guidance>"` sends the work back.

## Environment notes

- The account's five-hour usage limit was hit at 16:05 UTC on 2026-11-14 and cleared by 18:30 UTC.
  While it lasted, delegated agents and nested model workers returned HTTP 429; the build was done
  in one session and live runs were made afterwards.
- The limit was hit again at about 19:25 UTC (reset stated as 21:50 UTC). It stopped an independent
  audit of `docs/evidence-report.md` against `evidence/`. That audit is still owed: have a separate
  agent check every figure in the report and the handoff against the bundle files, read-only.
- `swarm_design` was not read: attaching it was declined by the session's permission check.
- State directories under `var/` are not committed. `evidence/` is.
