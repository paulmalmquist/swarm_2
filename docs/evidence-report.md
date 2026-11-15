# Evidence report

The subsequent manufacturing pilot has its own [synthetic receipts](../evidence/manufacturing/summary.json)
and [implementation limits](manufacturing.md). The regression-test count is checked against the
current suite; the live and fixture measurements are historical. No live manufacturing evidence
has been collected. CI writes fresh fixture results to `evidence/validation/`, so it does not
overwrite the historical bundles audited here.

**Historical evidence:** these live and fixture receipts precede the hardening in
[hardening.md](hardening.md). They do not validate the new tool-free worker protocol or stronger canary rules.

What was built, what ran, what improved, what failed and what remains unverified.
Recorded 2026-11-14. The figures below come from files under `evidence/` or from the test suite,
with three exceptions that rest on the author's account and say so: runs that were not kept, the
account of the build environment at the end of section 5, and the account of this report's own
checking in section 9. `npm run check:report` rebuilds the figures it covers from those files and
fails when this report says something else; section 9 says what it covers and what it does not.

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
| Tests for coordination, recovery, isolation, rollback | 95 tests, all passing | `tests/` |
| Reproducible demonstration commands | Nine demonstrations (seven on fixtures, two in testbeds with assumed rates), two live drivers | `demos/`, `package.json` |
| Example improvement receipts and release manifests | Receipts in every improvement bundle; manifests where a release was created | Receipts: `evidence/demo-c` to `-i`, `live-improve*`. Manifests: `demo-c`, `-d`, `-g`, `live-improve-2` |
| Architecture and integration documentation, operator guide | Written | `docs/` |

Connector ports exist with stated requirements; only local, labeled implementations are behind them.

## 2. Live results

### 2.1 Cross-swarm missions on real model workers

The same mission as demonstration A: four overlapping synthetic requests, discovery, acceptance
criteria, two delivery workstreams in separate git worktrees, integration, independent acceptance
on tests the workers never see, knowledge capture, review packet.

Live in these runs: discovery (haiku), acceptance criteria (sonnet), both implementers (sonnet),
knowledge capture (haiku; it ran to completion only in `live-c`). Scripted in these runs and
recorded as fixture attempts: the reference contract, the work graph and the delivery
decomposition, which come from the versioned coordination policy. Integration, verification and
the review packet are runtime steps.

| Run | Outcome | Elapsed | Model attempts | Rework | Integration failures | Acceptance criteria | Cost estimate | Waiting for a person |
|---|---|---|---|---|---|---|---|---|
| `live-a` | **Blocked** | 130 s | 7 | 4 | 0 | 4 of 5 passed, one of them after a repair; one failed three times | 0.62 USD | 1: what to do about the failed work |
| `live-b` | **Blocked** | 193 s | 9 (3 timed out) | 2 | 0 | 4 of 4 passed after two repairs | at least 0.41 USD | 1: what to do about the failed work |
| `live-c` | **Reached review** | 150 s | 6 | 1 | 0 | 4 of 4 passed after one repair | 0.35 USD | 2: the scope change, and the merge approval |

Cost figures are client-side list-price estimates, not billing. `live-b`'s is a lower bound: it
covers the six attempts that completed, and the three that were stopped at their deadline, after
about 22 s each, never reported what they used. Models served were recorded per attempt:
`claude-haiku-5-5` and `claude-sonnet-5-5`.

What these three runs establish:

- **Real workers' code met at a real boundary.** In all three runs the two independently written
  workstreams passed their own unit tests and the combined integration tests at the first attempt.
- **Independent verification caught what delivery's own tests did not.** In all three runs the
  first integrated result failed at least one hidden acceptance criterion after passing every test
  delivery had. See the caveat below before generalizing.
- **The repair loop repaired some failures and stopped at its limit on one.** In `live-a` a
  second criterion that failed in the first round was repaired at the next attempt. On the other,
  the worker was told only `an unmeasured dataset shows unknown and a dash`, read that as the
  complaint, and removed the dash; after the repair limit the mission stopped and asked a person.
  After the feedback was changed to state the requirement and show what the work produced,
  `live-b` repaired the same failure in two attempts and `live-c` in one. One run each, on
  different versions of the runtime: consistent with the feedback mattering, not a demonstration
  of it.
- **Workers said what they had not checked.** In the kept reports they named the tests they had
  not run and called a guess a guess (`live-b`: "this change is a guess at what the failed
  acceptance check wanted, so I'm not claiming AC-SLA-QUALITY is met"). They claimed only their
  own task's criteria, never the hidden acceptance criteria. The bundles keep each task's last
  report only (`worker-reports/`).
- **The harness scope held.** Six tool uses were refused across the runs (compound shell commands
  such as `mkdir … && cat > …` and `sed -i …`); none targeted a path outside a worktree.
- **Discovery narrowed the scope twice; the second time it reached a person.** In `live-b` and
  `live-c` discovery judged one authorized request (schema drift) to be a separate need. In
  `live-b` the narrowing was silent (section 5, item 9). In `live-c` it became a decision for the
  chief of staff while the rest proceeded, and the need is recorded as not covered.

Caveats that limit what these runs show:

- Three runs of one synthetic scenario. No rate should be read from them. They are not three
  samples of one system either: the runtime was being fixed between them (section 5, items 6 to
  10), so `live-a` has the old feedback text, `live-b` has no scope decision, and `live-c` has both
  fixes.
- The acceptance failure that recurs in all three runs (AC-SLA-QUALITY) has one cause: a hidden
  test requires an exact rendering (`| unknown | — |`) that no request and no criterion states.
  That is a defect in the fixture's acceptance suite, exposed by live execution and left in place.
  The independent check did its job; the requirement it enforced was nobody's. `live-a` also
  failed AC-SCHEMA-SUPPLY in its first round, for an alert that did not name the drifted field;
  that one was a real miss and was repaired.
- `live-a`'s bundle ends untidily. After the mission was blocked, the integration step ran once
  more, failed because one workstream was no longer accepted, and was queued again: item 7 in
  section 5, as it looked before the fix. That step error is not among the "0 integration
  failures", which counts merges and combined tests that failed. Its decision also offered only
  cancel and hold (item 8).
- `live-b`'s decision gave the person no reason: its question reads "Last rejection: not recorded".
  The failure was a timeout, not a rejection; the question now carries the last error instead.
- In `live-c` knowledge capture took 37.8 s against a time allowance of 21.6 s, the same allowance
  that timed it out three times in `live-b`. The deadline floor (item 10) let it finish, and the
  overrun is recorded as one.
- In a live mission the criterion *wording* is written by a model and the *check* is the scenario's
  pre-authored suite. They can diverge, and did: the model-written AC-CONTRACT asks for fields the
  reference contract does not have, and a worker said so. A verdict refers to the executable check.
- `live-b`'s bundle counts three acceptance failures; one of them is the knowledge task timing out,
  which is now recorded as an execution failure instead.
- `live-b`'s bundle also misstates what the mission spent. Its `budget.spent` block reads 0.65 USD,
  71,725 tokens and 8 model calls. Of that, 0.24 USD, 48,000 tokens and 2 calls are two transfers
  from the recovery reserve that the runtime booked as spending, and the three stopped attempts
  count as no model call at all. Both defects are fixed (section 5, items 14 and 15). The bundle
  was not edited; the table above uses what the completed attempts reported.
- `live-c`'s review packet opens with "4 of 4 acceptance criteria passed" and only further down
  shows the uncovered request. Packets now state uncovered requests in the first line; that bundle
  predates the change and was not edited.
- No decision was made on Paul's behalf in any live run. `live-c` is waiting, not approved.

Two earlier live runs were not kept as bundles, so nothing under `evidence/` backs what is said
about them. One was a one-agent mission: one sonnet call, 830 output tokens, 7 s, accepted by a
check that its output was present and not empty (its state is in a local directory that is not
committed). The other was a first cross-swarm attempt, of which nothing is left; it stranded a
task on a runtime defect described in section 5.

### 2.2 A real model as improvement author (Level 1)

The organization observed 13 verified failures in 40 development reviews by its change-review
skill (accuracy 68%). A model author (opus) was given those observations and 60 labeled
development cases in a workspace of its own, wrote an executable check for the skill, and
submitted it. The release gate ran it on held-out cases the author did not have. No model took
part in the judging.

What is live here is the authorship. The evaluation is a fixture evaluation, executing the check
on generated synthetic cases, and the receipts and the release manifest record it as such
("evidence basis: fixture").

| Run | Round | Development accuracy | Held-out set | Accuracy | Breaking changes approved | Safe changes blocked | Decision |
|---|---|---|---|---|---|---|---|
| `live-improve` | 1 | 1.00 | holdout-A | 0.50 → 0.9625 | 0.80 → 0 | 0 → **0.10** | **Reject** |
| `live-improve-2` | 1 | 1.00 | holdout-A | 0.50 → 0.9625 | 0.80 → 0 | 0 → **0.10** | **Reject** |
| `live-improve-2` | 2 (revision) | 1.00 | holdout-B | 0.4875 → 1.00 (difference 0.5125, 95% interval 0.40 to 0.625, n=80) | 0.95 → 0 | 0 → 0 | **Accept**, canary retained |

- Both first candidates were perfect on development cases and were rejected. On held-out cases
  they blocked 3 of the 6 changes that only make a field nullable, a safe kind of change that the
  development cases do not contain (the receipts' `known_regressions`). That is 10% of safe
  changes; the allowed increase is 5%.
- The revision was written from the gate's decision and three rates, plus fixed guidance that the
  development cases do not contain every kind of change and that it should look for safe changes
  it treats as breaking. It was not told which cases failed. That guidance was written by the
  author of the held-out cases.
- The revision was scored on a different held-out set, as a revision must be, and accepted. Its
  figures are identical to demonstration C's accepted revision because both were perfect on the
  same fixed set, `holdout-B`, which the scripted candidate had already been scored on in another
  state directory.
- The accepted check adds one step to every review (2 to 3). The gate's weighted cost criterion
  recorded that as failed; hard gates decide, so the candidate was accepted anyway.
- It was then tried in a canary and retained; the active release became `r2` in that state
  directory. The canary was one observation on 60 fresh cases, not a period of use, and it
  measured two of its three metrics: no mission ran under it, so the count of missions with
  acceptance failures is empty.
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
reused; engine and report were rebuilt, and the integration, knowledge and packet steps that
depend on them were redone; all criteria passed again.

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
earlier and later missions kept `r1`. An injected regression produced an accuracy drop well above
the limit of 0.05 (between 0.10 and 0.22 in the six bundles committed so far, which
`git log -p -- evidence/demo-g/canary.json` shows; a canary draws fresh cases every run, so the
size varies); the prior release was restored; 2 missions, 12 artifacts and 4 memories
that depended on the withdrawn release were identified and marked; one decision was opened about
the mission still in flight.

**Tests.** 95 tests pass in about two minutes: ownership and fencing, dependencies and
invalidation, budgets and authority, idempotency, cancellation, a full mission, five execution
patterns, recovery, the gate, isolation, canary and rollback, the arena, communication, connectors
and reconciled effects, limits, the portfolio, escalation and scope change, spend accounting,
stranded and blocked work, the path a live worker takes (with a scripted stand-in for the model),
the API, and checks that this report quotes the evidence files and that a planted error is caught.

## 4. Improvement and coordination experiments (fixture and simulation)

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
| No independent verification swarm | Worker invocations per mission 12.9 → 10.0; completion about 4 s → 3 s | Defects reaching an accepted result per mission 0 → 0.625; truly correct missions 1.00 → 0.375 (difference −0.625, interval −0.875 to −0.25) | **Reject** |
| No interface agreement before parallel work | Invocations per mission 11.75 → 12.0 (difference +0.25, interval −0.5 to 0.75); integration failures per mission 0 → 0.625 | Truly correct missions 1.00 → 1.00 | **Inconclusive**: no worse, but nothing saved |

For the interface agreement the measured costs are: the step costs one worker invocation per
mission, and a mission in which the workstreams disagreed cost one more invocation than the same
mission with the agreement. Counting invocations only, the step pays for itself when workstreams
would otherwise disagree in more than about half of missions. A fixture counts every invocation
the same; real rework usually costs more than a planning step, which would lower that figure.

Whether **hierarchy** improves outcomes over a single agent was not evaluated: with scripted
workers both arrangements produce the same code, and no live comparison was run.

## 5. What failed

Failures of the system, in the order they were found. Each is fixed unless it says otherwise,
and each fix has a test that exercises the corrected behaviour; the independent audit reverted
five of the fixes in a scratch copy (items 2, 7, 14, 15 and 16) and saw those tests fail.

Items 1 to 11 were found by running real workers. Items 1 to 5 came from attempts that were not
kept, so only this account backs them. Items 6, 7 and 8 can be seen in `live-a`, 9 and 10 in
`live-b`, and 11 in `live-c`. Items 12 and 13 were found by reasoning while building, and 14 to 18
by checking this report against its evidence and its own claims (section 9). Item 3 is an error
in instructions I wrote, not in the runtime.

1. **A worker-declared artifact path that was a directory stranded its task** (first live run).
   Workers now publish only contract-named outputs, code is taken from git, files must be regular
   and inside the workspace, and an unrecordable result fails the attempt.
2. **The coordinator went idle while leased work was still in flight.** It now stays up until the
   lease is renewed or reclaimed.
3. **My instructions to live workers named a test command that fails on this Node version.**
   A worker reported it, in the first attempt, which was not kept. Corrected.
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
14. **A retry paid from the recovery reserve was booked as spending** (`live-b`). The mission's
    spend included 0.24 USD and 48,000 tokens that nobody used, and the team above the retried
    task held more than its own limit. Allowance is now moved between accounts instead of
    consumed, and limits are reconciled against the ledger as consumption already was.
15. **A model attempt stopped at its deadline was recorded as no model call, no time and no cost**
    (`live-b`). It is now charged what the runtime measured, its tokens and cost are marked
    unknown instead of zero, and status, the review packet and the interface say when a total is
    a lower bound. A reused result in a live mission is also no longer counted as a model attempt.
16. **A check that threw left its result marked as being verified, and nothing looked at it
    again.** The fix for item 5 covered a result still waiting for its check, not one whose check
    had started, so the mission would have sat idle with nobody told. Found by writing the test
    item 5 did not have. Such a result is now checked again, by the same coordinator or the next
    one, and after three errors it goes back to its author and then to a person.
17. **A mission could stop with nobody asked.** A task that had run out of budget, hit the
    invocation cap or was waiting for a human review was shown as a blocker with an owner's name
    on it, but nothing was put in anyone's queue: the mission stayed "active" and the coordinator
    went idle. Found by looking for other ways into the state in item 16. A mission with work left
    and nothing able to run now stops, is shown as blocked, and asks the chief of staff once:
    release the blocked work, cancel, or hold. Waiting for provider capacity is not a stop.
18. **The documented live commands would have deleted the kept live evidence.** Run without a
    name, the live drivers wrote to `evidence/live-a` and `evidence/live-improve` and cleared them
    first, and the README and the handoff gave exactly those commands. Found by the independent
    audit. A run without a name now gets a new one, a name must be a single path segment, and a
    bundle that exists is not replaced unless `SWARM2_OVERWRITE=1` says it is meant.

Experiments that did not go the candidate's way, which is the gate working: the naive scripted
check, the cheaper check that skipped a required step, the tampering candidate, both first
model-written checks, retiring the verification swarm, and one fix in each portfolio campaign.
Dropping the interface agreement was inconclusive.

Outside the system, on the author's account only (nothing in the repository records it): the
account's usage limit was hit at 16:05 UTC and cleared by 18:30 UTC. For that period delegated
agents and nested workers returned HTTP 429, so the investigation and implementation I had
delegated came back empty and the build was done in one session. The limit was hit again at about
19:25 UTC (reset stated as 21:50 UTC), which stopped an independent agent partway through auditing
this report. Section 9 says how the report has been checked since.

## 6. What remains unverified

- **What was written after the independent audit began.** Section 5 items 17 and 18, section 9
  and the corrections made in response to the audit have been checked by the author and by the
  test, not by a second reader.
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
| Acceptance failures and escaped defects | `acceptance_failure` observations; oracle in episodes | 3, 2 and 1 failed acceptance rounds; escapes not measurable without an oracle | H: no mission with an escaped defect with verification, 5 of 8 without |
| Human correction and review effort | `human_correction` observations; decisions waiting | 0 corrections; 1, 1 and 2 decisions waiting | Tests exercise the path |
| Resource use per accepted outcome | Budget tree; provider usage | `live-c`: 14 worker invocations, 6 model calls, 31.7k output tokens, 0.35 USD estimate | A: 11 invocations, 0 model calls |
| Completion time and critical-path waiting | Events; `criticalPath()` | 130 to 193 s | A: about 3 s (scripted durations) |
| Integration failures and rework | Observations | 0 integration failures; 4, 2 and 1 reworks | H: 0.625 integration failures per mission without the agreement |
| Repeated mistakes | Failure signatures across missions | The same criterion failed first in all three runs | Not measured |
| Recovery success | Demonstration B, recovery tests | Not exercised in a kept run. In the first attempt, which was not kept, a restarted coordinator fenced and re-dispatched one stranded attempt | B: 9 of 9 checks |
| Useful improvements per fixed experiment budget | Receipts; exploration allocation | 1 accepted of 3 model-written candidates, for about 1.1 USD of author time | D: validated benefit of 177.6 against 165.0 per 100 reviews, on equal budgets of 420 units |
| Downstream regressions after promotion | Canary observations, rollbacks | None in one canary observation, which measured two of three metrics | G: injected regression rolled back |

Diagnostic activity (agents, messages, artifacts, proposals) is recorded per mission and shown in
the interface's metrics; it is not used as a measure of success anywhere.

## 8. Reproduce

```
npm test                                     # 95 tests
npm run demo:all                             # demonstrations A–I; rewrites evidence/demo-*
npm run check:report                         # the figures quoted here, rebuilt from evidence/
SWARM2_LIVE=1 node demos/live.ts live-x      # a live mission; writes evidence/live-x
SWARM2_LIVE=1 node demos/live-improve.ts live-improve-x
```

A live run without a name gets a new one, and never replaces a bundle that exists.

Fixture demonstrations are deterministic in outcome. Timings vary from run to run, and so does
the size of the regression that demonstration G measures, because a canary draws fresh cases every
time. Between the two most recent committed runs of all nine, nothing else in any bundle's
summary changed except identifiers, hashes, timestamps and which of two concurrent workers
finished first. Live runs are not repeatable in detail: the same command gave a blocked mission
twice and a reviewable one once, and the runtime was being fixed between those runs (section 5),
so they are not three samples of one system.

## 9. How this report was checked

Items 1 and 2 are the author's account of the author's own checking. Item 3 can be run. Item 4 is
the only check made by a reader other than the author.

1. **By its author when it was written.** Figures were read from the bundles, and several were
   corrected then.
2. **By its author again after the merge, reading every figure back from the files.** That pass
   found:
   - a stale figure: demonstration G's regression was quoted as 0.2167 where the committed bundle
     said 0.1333, because the figure varies by run and the report had not said so;
   - a sentence crediting workers with behaviour (claims marked `unknown`, a wrong command
     reported) that the kept bundles do not contain;
   - `live-b`'s cost given without saying that three stopped attempts are missing from it, and
     behind that the two accounting defects in section 5, items 14 and 15;
   - "each has a test", which was untrue for five of the fixes. The tests were then written, and
     one of them failed: item 16. Looking for other ways into that state found item 17;
   - 832 output tokens that were 830.

   It also made a mistake of its own, which item 4 caught.
3. **Mechanically, from now on.** `tests/report.test.ts` checks 113 fragments of this report, the
   handoff, the operator guide, the README and the progress notes against the evidence files.
   Most rebuild a figure from a file and require the document to contain it. Some are fixed
   sentences guarded by an assertion on the evidence. A figure that varies from run to run is
   checked as a band, not as a value. A second test plants 28 wrong figures in copies of the
   documents and requires the check to catch each one. Not covered: sections 5, 6 and 9, some of
   the caveats in section 2, and most of the handoff. The check establishes that a covered figure
   is the evidence's figure. It cannot establish that a sentence is a fair reading of it.
4. **Independently, by a separate agent that could read everything and change nothing.** It
   checked about 265 claims in this report and about 45 in the handoff against the files,
   reverted five fixes in a scratch copy to see whether their tests fail, and examined fourteen
   of the check's own claims. It confirmed the figures: every number in the tables of sections
   2.1, 2.2 and 7, in the fixture results and in section 4 matched its source. It reported 27
   findings and 10 omissions. All are addressed in this version:
   - **One statement was wrong, and the author's second pass had made it so.** That pass replaced
     a correct sentence with "the receipts do not itemize" what the rejected candidates got wrong.
     They do: three of six nullable-field changes.
   - **A hazard:** the documented live commands would have deleted the kept live evidence
     (section 5, item 18).
   - **The live results claimed more than three runs can carry:** the later repairs read as caused
     by the better feedback; a scope change "reached a person" when it did in one run of two; the
     runs read as samples of one system although the runtime changed between them.
   - **Omissions:** a second criterion that failed and was repaired in `live-a`; a step error at
     the end of `live-a`; a time overrun in `live-c`; a decision in `live-b` that gave no reason;
     the accepted candidate's failed cost criterion; a canary that measured two of three metrics.
   - **Labeling:** the improvement run's evaluation is fixture evidence; section 4 had fixture and
     simulation results under a heading that named only one.
   - **The handoff** said more than this report supports in five places.
   - **The check itself:** some of its claims were fixed text, and some figures were typed in
     instead of derived. Those now come from the files, and item 3 describes the check in the
     audit's terms, not the author's.

   What the audit could not check: anything on GitHub, the times in the usage-limit account, and
   the first cross-swarm attempt, of which nothing is left. It did not see the changes made after
   it began: section 5 items 17 and 18, this section, and the corrections it prompted have been
   checked by the author and by the test only.
