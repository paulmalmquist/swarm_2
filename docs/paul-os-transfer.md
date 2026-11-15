# Paul OS transfer and evaluation prompt

Run this from Paul OS's root if the checkout does not already exist:

```sh
mkdir -p "projects and repos"
git clone --branch main https://github.com/paulmalmquist/swarm_2.git "projects and repos/swarm_2"
```

Give the following prompt to the Paul OS agent. The repository contains the candidate mechanisms;
the work machine supplies the incumbent implementation and authorized work history.

```text
You are working inside Paul OS. Carry out a practical evaluation and selective transfer of mechanisms from swarm_2 into Paul OS. Start the work, implement the evaluation harness, run the comparisons available in this environment, and prepare tested improvements. Do not stop at a proposal.

Paul OS remains the chief of staff, the single front door, and the owner of priorities, integrations, continuity, and human review. The goal is better results on Paul's actual work, followed by demonstrated system-level recursive self-improvement. swarm_2 is an experimental reference whose complexity must earn its place.

1. Establish the actual starting point.
Find Paul OS's root, instructions, active entry point, agent definitions, skills, memory/context stores, tool integrations, review interface, and existing evaluation or promotion machinery. Locate "projects and repos/swarm_2"; if missing, clone https://github.com/paulmalmquist/swarm_2.git there. Inspect working trees before updating anything; preserve local changes and existing work. Record the exact commits, model settings, and runtime versions used in the comparison. Create an isolated evaluation branch/worktree and a private Paul OS project directory for results.

Read swarm_2's README.md, docs/handoff.md, docs/hardening.md, docs/evidence-report.md, docs/integration.md, and the relevant implementation/tests. Its synthetic demonstrations are machinery tests, not proof of superiority on real work. It has no live Slack/Jira/GitLab connector, and its revised live worker protocol still needs a smoke test. Check its scenario coupling and tool restrictions before assuming it can execute Paul OS tasks. Generated-code execution requires Linux isolation; use an approved compatible executor if the host differs, and do not weaken isolation to obtain a result.

2. Inventory before transferring.
Trace several real requests through intake, retrieval, planning, delegation, execution, verification, review, correction, and memory. Produce a compact capability map linking claims to implementation and observed runs. Classify each swarm_2 mechanism as already covered, promising, unnecessary, or incompatible. Include failure recovery, task decomposition, source provenance, independent verification, review invalidation, knowledge promotion, and learning from corrections. Keep manufacturing investigations and the dbt warehouse as optional specialist capabilities. Budgets and leases are implementation details, not the objective of this evaluation.

3. Construct work episodes from authorized history.
Use existing Paul OS access to Paul's Slack conversations, Jira issues, GitLab MRs/diffs/review comments, related repositories, and corrections. Sample work across analytics engineering/dbt/BigQuery, MR review, requests turned into plans or tickets, application changes, and knowledge retrieval/promotion, according to what actually exists. Include successful, failed, abandoned, ambiguous, and repeatedly corrected work. Link a Slack thread, ticket, and MR from the same initiative into one episode instead of counting them as independent cases.

For each episode record the request, task family, source references and revisions, start cutoff, repository snapshot, available inputs, constraints, expected artifact, independently stated acceptance criteria, later outcomes, and reconstruction limitations. Distinguish inability to recover old context from agent failure. A merged MR or closed ticket is an observed outcome, not an automatic correctness label. Do not invent requirements from later preferences that were unknowable at the starting point.

Keep company source material, evaluation answers, transcripts, and derived private examples in the approved Paul OS environment, outside this public repository. A .gitignore alone does not separate evaluator answers from an agent that can read the surrounding workspace.

4. Build a defensible replay harness.
Start with a small representative pilot to validate the harness, then expand the coverage needed to evaluate the selected mechanisms. Split by related initiative and time, keeping related episodes together. Separate development cases from evaluator-owned held-out cases. Expose only point-in-time inputs to replay workers; prevent later comments, git objects, memory entries, retrieval indexes, and unrestricted source searches from revealing the answer. Record any contamination that cannot be removed. Current Paul OS may already know historical answers; label those runs retrospective diagnostics and add genuinely new shadow work before making transfer claims.

Use a common task/result contract: case and input-version IDs, starting system version, expected artifact, execution status, produced artifact references, test results, source citations, human interventions, elapsed time, and failure reason. Preserve observable tool/action traces and artifact changes. Identify unsupported tasks and adapter failures separately; do not substitute scripted fixture work for model execution.

5. Run useful comparisons.
Compare A: current Paul OS; B: Paul OS plus one selected swarm_2 mechanism; and C: a simpler execution path where meaningful. Also assess swarm_2 end to end only for tasks its adapters actually support. For controlled mechanism comparisons, match model, effort, tools, starting information, and execution conditions; isolate all run state and repeat nondeterministic trials. Report practical as-operated comparisons separately when those controls cannot be matched. Preserve every attempted trial and its outcome, including timeouts and failures.

Freeze the scoring rubric before looking at results. Use executable artifact checks where possible, followed by blinded human review for judgment-dependent quality. Any model grader must be calibrated against human examples and cannot be the sole promotion authority. Score task completion, correctness, missed requirements/defects, unsupported claims, reviewability, rework, intervention, and time to a usable result. Measure Paul's review time when observed; label proxies and missing measurements honestly. Evaluate outward-facing clarity and appropriate brevity. Report by task family and failure severity, with uncertainty; do not hide a serious regression in an aggregate score or generalize from a tiny pilot.

For dbt work, preserve Staging → Intermediate → Mart → Consumer, explicit fact grains, conformed dimensions, sc_dim_ history, bridge_ relationships, and semantic-model consistency. Test fanout, late corrections, historical validity, and required parity against the actual task. These are specialist acceptance criteria, not requirements for every mission.

6. Transfer the smallest demonstrated improvement.
Choose a candidate based on observed failure evidence. Implement it in the isolated Paul OS branch, compare it against the unchanged incumbent, inspect regressions, and prepare the patch and concise review packet. Test removal of extra coordination layers where that may simplify the work. An inconclusive or negative result is a valid outcome and should prevent unsupported adoption. Complete at least one real baseline/challenger comparison and one candidate evaluation when the available access and runtime permit it. If blocked, finish all independent work and report the exact missing prerequisite without inventing results.

7. Establish the path to recursive improvement and layered swarms.
Keep one Paul OS entry point and one integrated review queue. Allow the chief of staff to delegate to capability teams, which may subdivide work when the task benefits; route verification and the final result back through the same mission. Use current Paul OS mechanisms wherever they already work. Show users the outcome, blocker, next action, and decision; keep internal coordination details available on drill-down.

Implement an improvement record linking observed failure → hypothesis → versioned patch → independent evaluation → promotion decision → subsequent outcome → rollback target. Separate improvements to skills/retrieval/tools, improvements to coordination, and improvements to how improvement opportunities are discovered and tested. Keep acceptance policy, authorization, evaluator custody, and final promotion authority outside the candidate's write scope. Changes to the evaluation process need an unchanged external check. Demonstrate successive improvement cycles on fresh work before claiming RSI; one successful patch is only the first cycle. Record whether an accepted change actually helps generate or validate the next improvement.

8. Finish with concrete, reviewable deliverables.
Save the capability map; private case manifest and split rules; runnable harness and exact replay commands; baseline/challenger results with evidence and limitations; tested candidate patch or justified rejection; and a compact architecture diagram showing the single front door, capability teams, verification, and improvement loop. Provide a prioritized next experiment based on the observed failures.

Proceed autonomously with authorized reads, local branches, reversible implementation, and tests. Reuse Paul OS's established authorization and review path for live integrations, outward messages, production changes, and adoption into its active loop. Historical replay must have no external side effects. Keep status updates concise and evidence-based. The final response should state what ran, what improved or failed, what is ready for review, and what remains unverified.
```
