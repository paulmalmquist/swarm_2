# swarm_2

An organization of agent swarms that sits beneath an existing chief of staff.

> Give the system an objective. It assembles an appropriate organization, coordinates the work,
> verifies the result, and uses the outcome to improve how future work gets done.

The chief of staff keeps priorities, attention, continuity and commitments. swarm_2 turns an
authorized objective into coordinated work and returns results, evidence, decisions and next
actions. It improves three things about itself, each versioned separately: how work is executed,
how it is coordinated, and how it finds improvements.

It never sends, merges, deploys or commits anyone to anything. It prepares, verifies and asks.

## Start here

| If you want to | Read |
|---|---|
| Know what it can do today and how to run, inspect and stop it | [docs/handoff.md](docs/handoff.md) |
| Know what ran, what improved, what failed and what is unverified | [docs/evidence-report.md](docs/evidence-report.md) |
| Operate it | [docs/operator-guide.md](docs/operator-guide.md) |
| Understand the design | [docs/architecture.md](docs/architecture.md) |
| Connect it to Paul OS, a model provider or a data system | [docs/integration.md](docs/integration.md) |
| See what the build environment actually provided | [docs/capability-matrix.md](docs/capability-matrix.md) |
| Pick the work up after a context reset | [PROGRESS.md](PROGRESS.md) |

## Run it

Node 22.18 or later. Nothing to install or build; there are no runtime dependencies.

```
npm test                 # 48 tests: coordination, recovery, isolation, rollback, limits, escalation
npm run demo:all         # demonstrations A–I on labeled fixtures; rewrites evidence/
node src/cli.ts init && node src/cli.ts serve --run      # the review interface at http://127.0.0.1:4317/
```

A mission, end to end:

```
node src/cli.ts init
node src/cli.ts ingest fixtures/scenarios/shared-capability/requests.json
node src/cli.ts submit --scenario shared-capability --title "Shared dataset-health capability" \
     --objective "One policy-driven view of dataset health." \
     --requests syn-req-001,syn-req-002,syn-req-003,syn-req-004
node src/cli.ts run
node src/cli.ts attention        # the decision waiting for you
```

Real model workers instead of fixtures (uses your Claude Code account; off by default):

```
SWARM2_LIVE=1 npm run demo:live                       # the cross-swarm mission on real workers
SWARM2_LIVE=1 node demos/live-improve.ts              # a real model writes an improvement candidate
```

Stop everything: `node src/cli.ts stop`.

## What is in the repository

| Path | Contents |
|---|---|
| `src/` | The runtime: typed contracts, durable store, kernel, coordination, providers, release gate, evolution, API and interface |
| `definitions/` | Versioned execution, coordination and evolution definitions (the baseline release) |
| `protected/` | Promotion policy, held-out cases and scoring code that candidates cannot write |
| `fixtures/` | Synthetic scenarios, a small fixture application, development cases and candidates |
| `demos/` | Demonstrations A–I and the two live runs |
| `evidence/` | What each demonstration and live run produced: checks, receipts, release manifests, timelines |
| `tests/` | The test suite |
| `docs/` | Architecture, integration, operator guide, capability matrix, evidence report, handoff |

## Reading the evidence honestly

Three kinds of evidence are kept apart everywhere — in API responses, in release manifests and in
the reports:

- **Live**: real model workers did the work.
- **Fixture**: real processes, real merges and real tests, but the work content is scripted.
  Useful for showing that coordination, recovery and the release gate behave as designed.
  It says nothing about how well models do the work.
- **Simulation**: a synthetic testbed (the improvement arena, mission episodes with assumed defect
  rates). It describes behaviour in the testbed, not rates in real work.

All requests, people, teams, datasets and review cases in this repository are invented and labeled
as synthetic. No connector to Slack, Jira, GitLab, BigQuery, dbt, Power BI, OpenMetadata,
Dreamcatcher, Strongbox or Paul OS exists yet; each is a port with a stated requirement.
