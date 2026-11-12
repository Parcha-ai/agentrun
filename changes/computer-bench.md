---
packages: @parcha/agentrun-computer-bench
kind: feature
---
computer-bench, a benchmark of an agent's computer use, as a new private package. A task is a folder (`task.json`, its schema in `schema/task.schema.json`, an optional `rubric.md`): what computer it needs, setup as protocol calls, the instruction, a budget, and checks that read the computer's real state through the protocol before it is released. The runner is generic: arms (harness, surface, model) run every task on the same seeds, infra outcomes are run again and never scored, and every run writes a record of its protocol calls with images kept once by hash.
- Stage 1 is the checks; stage 2 is one grader with the rubric stated once (`templates/grader-prompt.md`, `templates/rubric.md`) that answers a verdict, a failure locus and a rationale. A disagreement goes to `human-queue.jsonl`, and a person's `labels.jsonl` overrides a verdict.
- `computer-bench report` gives each arm's success with intervals clustered by task, steps, cost, wall time, the mix of routes and the stale count, in markdown and JSON. `computer-bench verify` proves a suite's checks with no model: each fails the untouched state and passes the oracle's.
- Suites: `mac-dev` and `android-dev` (20 tasks each, half held out), and the first ports of macOSWorld and MobileWorld tasks with a port plan for each. A fake world and fake agents run the whole loop at $0, and a `ui-fixture` suite runs it on the protocol's fake ui driver.
- The serve backend is written against routes serve does not have yet (a run held for the bench, a bench channel to its computer, a release); README.md lists them. Until serve has them, a bench run stops before it claims any computer, with one error that names each missing route.
- A setup or oracle act counts a step as done only when the driver answers `verified: true`; `verified: false` is unconfirmed, never a pass.
