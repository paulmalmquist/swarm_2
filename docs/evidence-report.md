# Evidence report

The subsequent manufacturing pilot has its own [synthetic receipts](../evidence/manufacturing/summary.json)
and [implementation limits](manufacturing.md). Test counts below describe this historical report,
not the current suite. No live manufacturing evidence has been collected.

**Historical evidence:** these live and fixture receipts precede the hardening in
[hardening.md](hardening.md). They do not validate the new tool-free worker protocol or stronger canary rules.

What was built, what ran, what improved, what failed and what remains unverified.
Recorded 2026-11-14. Every figure below comes from a file under `evidence/` or from the test
suite, and can be reproduced with the commands in the last section.

## How to read this

Three kinds of evidence are reported separately and never combined:

| Kind | What it is | What it can and cannot show |
|---|---|---|
| **Live** | Real model workers (`claude -p`) did the work | How the organization behaves with real models. Small samples: three missions and two authoring runs |
| **Fixture** | Real processes, leases, merges and tests; the work content is scripted and labeled | That coordination, recovery, isolation and the release gate behave as designed. Nothing about how well models do the work |
| **Simulation** | Synthetic testbeds with assumed rates: the improvement arena, mission episodes | Behaviour inside the testbed under its stated assumptions. Not rates in real work |

All requests, people, teams, datasets and review cases are invented. Nothing touched a real
system: no connector to Slack, Jira, GitLab, BigQuery, dbt, Power BI, OpenMetadata, Dreamcatcher,
Strongbox or Paul OS was reachable (`docs/capability-matrix.md`).

## 1. What was built

| Deliverable | State | Where |
|---|---|---|
| Working runtime and usable interface | Built; exercised live and on fixtures | `src/`, `swarm2 serve` |
| Versioned agent, swarm, coordination and evolution definitions | Built; three levels versioned independently and combined in release manifests | `definitions/`, `src/gate/registry.ts` |
| Typed contracts and durable state | Built | `src/contracts/types.ts`, `src/store/` |
| Provider and chief-of-staff adapters | Built: a fixture provider, a live `claude -p` provider, a local chief-of-staff port over three transports | `src/providers/`, `src/cos/port.ts` |
| Separation of real execution from fixtures | Built: provenance on every response, per-attempt provider, evidence basis on every release | `docs/architecture.md` §8 |
| Executable evaluation and promotion mechanism | Built: release gate, held-out sets, receipts, canary, rollback | `src/gate/` |
| Tests for coordination, recovery, isolation, rollback | 49 tests, all passing | `tests/` |
| Reproducible demonstration commands | Nine fixture demonstrations, two live drivers | `demos/`, `package.json` |
| Example improvement receipts and release manifests | In every improvement bundle | `evidence/demo-c`, `-d`, `-e`, `-g`, `-h`, `-i`, `live-improve*` |
| Architecture and integration documentation, operator guide | Written | `docs/` |

Connector ports exist with stated requirements; only local, labeled implementations are behind them.

## 2. Live results

### 2.1 Cross-swarm missions on real model workers

The same mission as demonstration A: four overlapping synthetic requests, discovery, acceptance
criteria, two delivery workstreams in separate git worktrees, integration, independent acceptance
on tests the workers never see, knowledge capture, review packet.

Live in these runs: discovery (haiku), acceptance criteria (sonnet), both implementers (sonnet),
knowledge capture (haiku). Scripted in these runs and recorded as fixture attempts: the reference
contract, the work graph and the delivery decomposition, which come from the versioned
coordination policy. Integration, verification and the review packet are runtime steps.

| Run | Outcome | Elapsed | Model attempts | Rework | Integration failures | Acceptance criteria | Cost estimate | Waiting for a person |
|---|---|---|---|---|---|---|---|---|
| `live-a` | **Blocked** | 130 s | 7 | 4 | 0 | 4 of 5 passed; one failed three times | 0.62 USD | 1: what to do about the failed work |
| `live-b` | **Blocked** | 193 s | 9 (3 timed out) | 2 | 0 | 4 of 4 passed after two repairs | 0.41 USD | 1: what to do about the failed work |
| `live-c` | **Reached review** | 150 s | 6 | 1 | 0 | 4 of 4 passed after one repair | 0.35 USD | 2: the scope change, and the merge approval |

Cost figures are client-side list-price estimates, not billing. Models served were recorded per
attempt: `claude-haiku-5-5` and `claude-sonnet-5-5`.

What these three runs establish:

- **Real workers' code met at a real boundary.** In all three runs the two independently written
  workstreams passed their own unit tests and the combined integration tests at the first attempt.
- **Independent verification caught what delivery's own tests did not.** In all three runs the
  first integrated result failed at least one hidden acceptance criterion after passing every test
  delivery had. See the caveat below before generalizing.
- **The repair loop works when the feedback is usable, and stops when it is not.** In `live-a` the
  worker was told only `an unmeasured dataset shows unknown and a dash`, read that as the
  complaint, and removed the dash; after the repair limit the mission stopped and asked a person.
  With feedback stating the requirement as a requirement and showing what the work produced,
  `live-b` repaired it in two attempts and `live-c` in one.
- **Workers reported honestly.** They marked claims `unknown` when they could not run tests, named
  a wrong command in their own instructions, and listed guesses as guesses (`worker-reports/`).
- **The harness scope held.** Six tool uses were refused across the runs (compound shell commands
  such as `mkdir … && cat > …` and `sed -i …`); none targeted a path outside a worktree.
- **A scope change reached a person.** In `live-b` and `live-c` discovery judged one authorized
  request (schema drift) to be a separate need. In `live-c` that became a decision for the chief of
  staff while the rest proceeded, and the need is recorded as not covered.

Caveats that limit what these runs show:

- Three runs of one synthetic scenario. No rate should be read from them.
- The recurring acceptance failure has one cause: a hidden test requires an exact rendering
  (`| unknown | — |`) that no request and no criterion states. That is a defect in the fixture's
  acceptance suite, exposed by live execution and left in place. The independent check did its job;
  the requirement it enforced was nobody's.
- In a live mission the criterion *wording* is written by a model and the *check* is the scenario's
  pre-authored suite. They can diverge, and did: the model-written AC-CONTRACT asks for fields the
  reference contract does not have, and a worker said so. A verdict refers to the executable check.
- `live-b`'s bundle counts three acceptance failures; one of them is the knowledge task timing out,
  which is now recorded as an execution failure instead.
- `live-c`'s review packet opens with "4 of 4 acceptance criteria passed" and only further down
  shows the uncovered request. Packets now state uncovered requests in the first line; that bundle
  predates the change and was not edited.
- No decision was made on Paul's behalf in any live run. `live-c` is waiting, not approved.

Two earlier live runs were not kept as bundles: a one-agent mission (one sonnet call, 832 output
tokens, 7 s, accepted on inspection), and a first cross-swarm attempt that stranded a task on a
runtime defect described in section 5.

### 2.2 A real model as improvement author (Level 1)

The organization observed 13 verified failures in 40 development reviews by its change-review
skill (accuracy 68%). A model author (opus) was given those observations and 60 labeled
development cases in a workspace of its own, wrote an executable check for the skill, and
submitted it. The release gate ran it on held-out cases the author did not have. No model took
part in the judging.

| Run | Round | Development accuracy | Held-out set | Accuracy | Breaking changes approved | Safe changes blocked | Decision |
|---|---|---|---|---|---|---|---|
| `live-improve` | 1 | 1.00 | holdout-A | 0.50 → 0.9625 | 0.80 → 0 | 0 → **0.10** | **Reject** |
| `live-improve-2` | 1 | 1.00 | holdout-A | 0.50 → 0.9625 | 0.80 → 0 | 0 → **0.10** | **Reject** |
| `live-improve-2` | 2 (revision) | 1.00 | holdout-B | 0.4875 → 1.00 (difference 0.5125, 95% interval 0.40 to 0.625, n=80) | 0.95 → 0 | 0 → 0 | **Accept**, canary retained |

- Both first candidates were perfect on development cases and were rejected: they blocked 10% of
  safe changes of kinds the development cases do not contain. The allowed increase is 5%.
- The revision was written from the gate's aggregate result only (the decision and three rates).
  It was scored on a different held-out set, as a revision must be. It was accepted, tried on fresh
  cases in a canary, and retained; the active release became `r2` in that state directory.
- Author effort: 81 to 94 seconds and 0.32 to 0.42 USD (list-price estimate) per round.
- The harness refused four tool uses by the author across the runs: ad hoc `node -e` scripts where
  only the development check was permitted. None reached outside the workspace.

Caveats: one line of work, on a synthetic review workload, judged by executing checks on generated
cases. The author was confined by the worker harness (file tools scoped to its workspace), not by
the operating system, and the held-out case generator sits in the same repository. The candidate's
*code* was executed by the gate under a separate OS user.

## 3. Fixture results

Scripted workers; real runtime. These show mechanism, not capability. Each line is a
demonstration whose every check held (`evidence/demo-*/README.md`).

**A. Cross-swarm delivery — 14 of 14 checks.** Four of five requests nominated as one mission and
the unrelated one left out; five swarm capabilities took part (discovery, planning, delivery,
verification, reliability); three delegated layers; each stakeholder's need tied to its own
criterion; two workstreams concurrent in separate worktrees, 8 worker processes; merged in a
serialized queue; all five criteria passed by the verification swarm on tests delivery never saw;
18 of 18 tasks accepted; 24 budget accounts reconcile; 158 events, chain intact; approval recorded
and nothing merged or sent.

**B. Failure recovery — 9 of 9.** A killed worker lost its lease and the work was re-leased under
a new fencing token; the presumed-dead worker later presented its old token and was refused; a
second coordinator resumed from the store alone and stopped an orphaned worker; five redelivered
requests were ignored, a repeated command returned the original mission, and a reused key with a
different body was refused; revising the upstream contract invalidated exactly its dependents;
the pending review decision was superseded; discovery, criteria, plan and decomposition were
reused and only engine and report were rebuilt; all criteria passed again.

**E. Rejection — 5 of 5.** A candidate cut review steps from 2 to 1 by omitting a required
verification step. The gate rejected it on a hard gate. On held-out cases the share of breaking
changes approved rose from 0.80 to 1.00. The candidate and its receipt are kept.

**F. Isolation — 7 of 7.** The host provided enforced separation: candidate code ran as uid
65534 against a store owned by uid 0 with mode 0700. A tampering candidate was rejected by static
screening before any of its code ran. Run anyway for the demonstration, all six attempts
(overwrite the policy, overwrite the scoring rules, read the held-out cases, append to the ledger,
rewrite the release pointer, plant a result) were denied. With Node's permission model removed,
the operating system alone denied all five attempts made. A proposal to change the rules became a
decision for a person and changed nothing. An out-of-band edit by the operator account was
detected by digest and the gate refused to decide.

**G. Canary and rollback — 8 of 8.** An accepted release ran in a canary of two missions while
earlier and later missions kept `r1`. An injected regression produced an accuracy drop of 0.2167
against a limit of 0.05; the prior release was restored; 2 missions, 12 artifacts and 4 memories
that depended on the withdrawn release were identified and marked; one decision was opened about
the mission still in flight.

**Tests.** 49 tests pass in about two minutes: ownership and fencing, dependencies and
invalidation, budgets and authority, idempotency, cancellation, a full mission, five execution
patterns, recovery, the gate, isolation, canary and rollback, the arena, communication, connectors
and reconciled effects, limits, the portfolio, escalation and scope change, and the API.

## 4. Simulation and testbed results

### 4.1 First-order improvement with scripted candidates (demonstration C — fixture)

A first candidate raised held-out accuracy from 0.50 to 0.60 but blocked 50% of safe changes and
was rejected. Its revision, on a different held-out set, went from 0.4875 to 1.00 (difference
0.5125, 95% interval 0.40 to 0.625, n=80), was accepted, survived a canary and was retained.
Both candidates were written by the same author as the held-out cases, so this shows the
lifecycle, not an independent improvement. Section 2.2 is the independent version.

### 4.2 Improving the improvement process (demonstration D — simulation)

Two improvement policies, equal budgets of 420 units, the same 30 unseen failure episodes.
"Frequency first" works on whatever is reported most. "Expected value" ranks by verified failures
times severity per unit cost, pilots a fix before paying for a held-out evaluation, and stops when
nothing is worth its cost.

| Measure | Frequency first | Expected value | Difference (95% interval) |
|---|---|---|---|
| Independently validated benefit per 100 reviews | 165.0 | 177.6 | +12.6 (0.42 to 25.4); sign test 11 better, 2 worse, 17 same, p=0.022 |
| Budget spent on fixes that failed | 207.3 | 120.1 | −87.3 (−113.3 to −62.1) |
| Budget spent | 411.3 | 372.8 | |

Decision: **accept**, by the frozen rule — and narrowly. The interval's lower bound is 0.42. With
the testbed's deliberately planted, frequently reported, never verified complaint class removed,
the advantage is **not demonstrated** (+5.6, interval −5.2 to 16.7). In 2 of 30 episodes the new
policy did worse. Both policies and the testbed were written by the same author. What the result
supports is narrow: in this testbed the new policy wastes less on failed experiments, and its
benefit advantage depends on there being noise to ignore.

### 4.3 The policy in force running the organization's own improvement work (demonstration I — fixture, case study)

One campaign per policy on the same recorded observations and a budget of 900 units, each
submitting to the real release gate. Not a statistical comparison.

| | Frequency first (`r1`) | Expected value (in a canary) |
|---|---|---|
| First step | Built a fix for the loudest, unverified complaint | Built a fix for verified failures, then piloted it |
| Accepted | 1 | 1 (the same fix) |
| Not accepted | 1 inconclusive: no demonstrated improvement | 1 rejected: blocked 13.5% of safe changes |
| Units on experiments not accepted | 301 | 323 |
| Units on builds never submitted | 90 | 0 |
| Units used | 712 | 656 |

The new policy did **not** spend less on a failed experiment here: its pilot passed a fix that the
gate then rejected. It avoided the unverified complaint and wasted nothing on builds it could not
afford to submit. The canary was then retained, and a fix qualified against the old default was
refused promotion over the new one.

### 4.4 Targeted comparisons against simpler configurations (demonstration H — simulation)

Eight complete fixture missions per configuration, with an oracle rerunning the acceptance suite on
whatever each mission accepted. The rates at which defects and interface disagreements occur are
assumptions of the testbed.

| Simpler configuration | Cost | Quality | Decision |
|---|---|---|---|
| No independent verification swarm | Worker invocations per mission 12.9 → 10.0; completion about 4.1 s → 3.0 s | Defects reaching an accepted result per mission 0 → 0.625; truly correct missions 1.00 → 0.375 (difference −0.625, interval −0.875 to −0.25) | **Reject** |
| No interface agreement before parallel work | Invocations per mission 11.75 → 12.0 (difference +0.25, interval −0.5 to 0.75); integration failures per mission 0 → 0.625 | Truly correct missions 1.00 → 1.00 | **Inconclusive**: no worse, but nothing saved |

For the interface agreement the measured costs are: the step costs one worker invocation per
mission, and a mission in which the workstreams disagreed cost one more invocation than the same
mission with the agreement. Counting invocations only, the step pays for itself when workstreams
would otherwise disagree in more than about half of missions. A fixture counts every invocation
the same; real rework usually costs more than a planning step, which would lower that figure.

Whether **hierarchy** improves outcomes over a single agent was not evaluated: with scripted
workers both arrangements produce the same code, and no live comparison was run.

## 5. What failed

Failures of the system, found by running it, in the order they were found. Each is fixed unless
it says otherwise, and each has a test.

1. **A worker-declared artifact path that was a directory stranded its task** (first live run).
   Workers now publish only contract-named outputs, code is taken from git, files must be regular
   and inside the workspace, and an unrecordable result fails the attempt.
2. **The coordinator went idle while leased work was still in flight.** It now stays up until the
   lease is renewed or reclaimed.
3. **My instructions to live workers named a test command that fails on this Node version.**
   A worker reported it. Corrected.
4. **A worker that reported itself blocked waited on an agent that could not act.** Work with all
   outputs delivered now goes to verification; otherwise the question goes to a person.
5. **A shapeless plan object crashed plan validation, and the check was retried without end.**
   Proposals are shape-checked; repeated verification errors go back to the author.
6. **Verifier feedback could be read as the complaint**, and cost a mission its repair limit
   (`live-a`). Feedback now states the requirement that did not hold and what was produced.
7. **Accepted work that later failed left its team marked done**, so integration retried until its
   budget ran out. The team is reopened and integration waits.
8. **No way for a person to send failed work back.** A failure escalation now offers one more
   repair with the person's guidance, recorded as a correction.
9. **Discovery could narrow an authorized mission silently** (`live-b`). Now a scope decision.
10. **A live worker's deadline was a small share of the time budget** and timed out three times
    (`live-b`). Live attempts have a floor.
11. **A review packet read as covering a request it did not cover** (`live-c`). Fixed for new packets.
12. **A release qualified against an old default could have been promoted over a newer one.**
    Found by reasoning while building the portfolio. Now refused.
13. **The versioned improvement policy drove only the testbed**, not the organization's own
    improvement work. The portfolio closes that.

Experiments that did not go the candidate's way, which is the gate working: the naive scripted
check, the cheaper check that skipped a required step, the tampering candidate, both first
model-written checks, retiring the verification swarm, and one fix in each portfolio campaign.
Dropping the interface agreement was inconclusive.

Outside the system: the account's usage limit was hit at 16:05 UTC and cleared by 18:30 UTC. For
that period delegated agents and nested workers returned HTTP 429, so the investigation and
implementation I had delegated came back empty and the build was done in one session. The limit
was hit again at about 19:25 UTC (reset stated as 21:50 UTC). That stopped an independent agent
partway through auditing this report against the evidence files, so **this report has been
checked against its sources by its author only**. The figures were read from the bundles when it
was written; an independent check is still owed.

## 6. What remains unverified

- **This report, independently.** See the end of section 5.
- **Anything at scale.** Three live missions and two live authoring runs, one scenario each.
- **Live coordination and improvement-policy experiments.** Levels 2 and 3 were evaluated on
  fixture episodes and a synthetic arena only.
- **Live planning.** The work graph in live missions is a policy template; a model does not yet
  propose it. Validation of proposals exists and is tested with malformed input.
- **Acceptance tests derived from criteria.** They are pre-authored for the scenario. The live runs
  show why that matters.
- **OS-enforced isolation of model workers and model authors.** They cannot authenticate as an
  unprivileged user without a separate credential. Their confinement is the harness's path-scoped
  rules, verified by probe on the installed CLI version and recorded per attempt.
- **Protection from the operator.** The account that runs the gate can edit the protected store.
  That is detected, not prevented.
- **Held-out independence.** The held-out generators are in this repository. Any author with read
  access to the repository outside the harness could see them. Sets `holdout-A`, `holdout-B`,
  `arena-A`, `missions-A` and `missions-B` have been revealed to me and are development data for
  anything I write next.
- **Every real integration.** Paul OS, Slack, Jira, GitLab, BigQuery, dbt, Power BI, OpenMetadata,
  Dreamcatcher and Strongbox are ports with requirements. `swarm_design` was not read.
- **Billing.** Costs are list-price estimates from the client. Subscription usage is not measured.
- **Calibration of any model judgment.** None is used: every verdict in this build comes from an
  executable check or a structural inspection. Inspections check that a document has the required
  parts, not that it is right.
- **Concurrency near the limit.** The cap of 12 concurrent calls is enforced and tested; no run
  used more than two live workers at once.
- **The promotion thresholds** (margins, sample sizes, exposure caps, the experiment allocation)
  are first settings, not tuned ones.

## 7. Outcome metrics

Where each requested metric is measured, and its value in the evidence that exists.

| Metric | Source | Live (3 missions) | Fixture / simulation |
|---|---|---|---|
| Independently accepted mission outcomes | Mission status after independent acceptance | 1 reached review; 2 stopped for a person | A: 1 of 1; H: 8 of 8 per incumbent arm |
| Acceptance failures and escaped defects | `acceptance_failure` observations; oracle in episodes | 3, 2 and 1 failed acceptance rounds; escapes not measurable without an oracle | H: 0 escapes with verification, 5 in 8 missions without |
| Human correction and review effort | `human_correction` observations; decisions waiting | 0 corrections; 1, 1 and 2 decisions waiting | Tests exercise the path |
| Resource use per accepted outcome | Budget tree; provider usage | `live-c`: 14 worker invocations, 6 model calls, 31.7k output tokens, 0.35 USD estimate | A: 11 invocations, 0 model calls |
| Completion time and critical-path waiting | Events; `criticalPath()` | 130 to 193 s | A: about 3 s (scripted durations) |
| Integration failures and rework | Observations | 0 integration failures; 4, 2 and 1 reworks | H: 0.625 integration failures per mission without the agreement |
| Repeated mistakes | Failure signatures across missions | The same criterion failed first in all three runs | Not measured |
| Recovery success | Demonstration B, recovery tests | In the first, unrecorded attempt a restarted coordinator fenced and re-dispatched one stranded attempt | B: 9 of 9 checks |
| Useful improvements per fixed experiment budget | Receipts; exploration allocation | 1 accepted of 3 model-written candidates, for about 1.1 USD of author time | D: 177.6 against 165.0 per 420 units |
| Downstream regressions after promotion | Canary observations, rollbacks | None observed in one canary | G: injected regression rolled back |

Diagnostic activity (agents, messages, artifacts, proposals) is recorded per mission and shown in
the interface's metrics; it is not used as a measure of success anywhere.

## 8. Reproduce

```
npm test                                     # 49 tests
npm run demo:all                             # demonstrations A–I; rewrites evidence/demo-*
SWARM2_LIVE=1 node demos/live.ts live-x      # a live mission; writes evidence/live-x
SWARM2_LIVE=1 node demos/live-improve.ts live-improve-x
```

Fixture demonstrations are deterministic in outcome; timings vary. Live runs are not repeatable
in detail: the same command gave a blocked mission twice and a reviewable one once, for the
reasons in section 5.
