# Chief-of-staff handoff

For the chief of staff, and for Paul reading over its shoulder. Five questions, answered from what
exists on 2026-11-14. Detail and every figure's source are in [evidence-report.md](evidence-report.md).

## What can this organization do today?

Take an authorized objective and carry it to a reviewable result, or stop and say why.

Given a mission, it forms the swarms the work needs (discovery, planning, delivery, verification,
reliability), divides delivery into teams that work at the same time in separate workspaces,
integrates what they produce, has a different swarm verify the result on checks the authors never
see, sends failed work back with the reason, records what it learned, and hands you a review
packet with the exact changes, the acceptance evidence, the remaining concerns and one decision.

It has done this with real model workers three times on one synthetic scenario. In those runs
models did the discovery, the acceptance criteria, the implementation and the knowledge capture;
the work graph and the split into teams came from a fixed policy template. Once it reached
review. Twice it stopped and asked a person: once because a pre-written acceptance test demanded
something no requirement states, once because a deadline in the runtime, since fixed, timed out
the last step.

It can also change itself: propose an improvement to how work is executed, coordinated or
improved, test it against held-out cases, and adopt it only if a release gate accepts it and a
bounded trial survives. Candidate code cannot change the gate's rules or records: the operating
system enforces that for the code, and the worker harness for a model that writes it. A real
model wrote one such improvement that was accepted, after its first version was rejected. It was
judged by executing it on synthetic cases, not by use.

It cannot yet reach any of your real systems. It does not send, merge, deploy or commit you to
anything, and it is not built to: those stay with you.

## How does it coordinate?

Through durable state and contracts, not conversation.

- Every piece of work has **one owner under a lease**. If the owner goes quiet the work is
  reclaimed, and a late result from the old owner is refused.
- Every delegation, to an agent or to a whole swarm, is **one contract**: objective, measurable
  acceptance criteria, inputs pinned to exact versions, write scope, budget, stopping conditions.
- **Agents propose; the runtime decides.** A plan, a result and a claim are all proposals. Only a
  passing, independent check accepts work.
- When something upstream changes, **exactly what depended on it is redone**, and verified work
  whose inputs did not change is reused.
- A child can never hold more **budget or authority** than its parent. Capacity for verification,
  recovery and completion is set aside before delivery starts.
- What needs a person **comes to you as a decision** with options and consequences: a merge
  approval, a conflict, work that failed for good, a worker that is blocked, a limit reached, a
  mission that has stopped because nothing in it can run, a request the analysis left out of
  scope, a proposed change to the rules.

## What did it attempt to improve?

| Level | What was tried | Evidence | Result |
|---|---|---|---|
| Execution | A real model wrote an interface-compatibility check for change review | Live author, fixture evaluation | First version **rejected**: perfect on development cases, but it blocked 10% of safe changes on held-out cases. Revision **accepted** on a different held-out set (accuracy 0.49 → 1.00) and retained after a trial. It adds a step to every review |
| Execution | A cheaper review procedure that skipped a required step | Fixture | **Rejected** |
| Execution | A candidate that tried to rewrite the rules and records | Fixture | **Rejected** before its code ran; every attempt denied when run anyway |
| Coordination | Retire the independent verification swarm | Simulation | **Rejected**: cheaper and faster in the testbed, and injected defects reached accepted results |
| Coordination | Drop the interface agreement before parallel work | Simulation | **Inconclusive**: no worse, nothing saved |
| Improvement process | Rank improvement work by expected value, pilot before submitting, stop when nothing is worth its cost | Simulation, then a fixture case study | **Accepted**, narrowly, in a synthetic testbed; then run in a bounded trial on a synthetic review workload, and retained |

## What evidence supports the result?

- **Live, small:** three missions and two improvement runs with real models. Enough to show the
  organization works with real workers and where it broke; not enough to state any rate. The
  runtime was being fixed between the missions, so they are not three samples of one system.
- **Fixture:** nine demonstrations and 66 tests show the machinery — ownership, recovery,
  invalidation, isolation, the gate, trial and rollback — behaves as designed with scripted workers.
- **Simulation:** the coordination and improvement-process comparisons rest on testbeds with
  assumed rates, written by the same author as the candidates. One accepted result is narrow and
  disappears under a sensitivity check; the report says so.

Running it with real workers surfaced eleven problems that scripted workers never triggered
(report section 5, items 1 to 11). The kept bundles show six of them; the other five come from
attempts that were not kept. Checking the report against its own evidence afterwards found five
more: two in how spend was counted, two that could leave a mission stopped with nobody told, and
one in the live commands themselves, which would have overwritten the kept evidence. All are
listed in the report with what was changed. Three things worth knowing before relying on it:

1. Acceptance tests in the scenario are pre-written. One of them demands something no requirement
   states, and that cost a live mission its repair limit. In real use, someone has to own the tests.
2. Model workers are confined by the worker harness's file rules, not by the operating system.
   That was verified by probe, and every refused action is recorded, but it is a weaker boundary.
3. Held-out cases live in this repository. They are held out from candidate authors only as long
   as those authors work inside the harness.

## How do I run it, inspect it, and stop it?

From the repository root, with Node 22.18 or later and nothing to install:

| To | Run |
|---|---|
| See it work on fixtures | `npm run demo:all`, then read `evidence/demo-a/README.md` |
| Open the review interface | `node src/cli.ts init && node src/cli.ts serve --run` → http://127.0.0.1:4317/ |
| Submit a mission | `node src/cli.ts submit --scenario shared-capability --title "…" --objective "…"` |
| Use real model workers | add `--live` and set `SWARM2_LIVE=1`; or `SWARM2_LIVE=1 npm run demo:live`, which writes a new bundle under `evidence/` and never replaces a kept one |
| See what needs you | `node src/cli.ts attention` |
| Decide | `node src/cli.ts decide <decision> <option> --rationale "…"` |
| Read the evidence for a result | `node src/cli.ts evidence <mission> --md` |
| See how it is changing itself | the Evolution view, or `node src/cli.ts gate status` |
| **Stop everything** | `node src/cli.ts stop` |
| Stop one mission | `node src/cli.ts cancel <mission> --reason "…"` |
| Undo an improvement in trial | `node src/cli.ts gate canary rollback <canary> --reason "…"` |

Stopping loses nothing: the next run resumes from stored state.

## Decisions waiting for Paul

1. **Whether to connect it, and to what first.** Paul OS is the natural first connection: it
   submits missions and shows what `attention` returns. The requirement is in `integration.md`.
2. **A separate credential for model workers**, so their isolation is enforced by the operating
   system and not only by the harness.
3. **Who owns acceptance tests** in real missions.
4. **The promotion rules.** The thresholds in `protected/policy.json` are first settings.
   Changing them is your decision; no experiment can.

Pull request #1 was merged into `main` on 2026-11-14. Pull request #2 carries the corrections
that came out of checking the report; anything later arrives the same way.
