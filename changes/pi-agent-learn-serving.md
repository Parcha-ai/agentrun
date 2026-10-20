---
packages: @parcha/pi-agent-learn
kind: feature
---
**The host serves a proven workflow itself, before the agent, and a trial is promoted after 2 clean runs by default**
- `planServing({ repo, sha, workDir, workflows, takes })` picks what to serve for a run: the live revision when it is active; while it is on trial, the revision it superseded, the last one proven (a canary), read from the repository and checked against its digest, so the trial still earns its place through the agent; nothing for a first revision on trial. A superseded revision whose record does not read is passed over for the one before it.
- `serve({ harness, workflows, context, plan, input, tools, check })` runs the plan as a durable workflow task under `host:<name>:<sha256>:<input hash>` (`hostKey`, `hostRunName`), after the checks the `agentrun` tool makes (a refusal writes no task). A complete run whose output the host's `check` accepts is the answer; one it refuses is escalated with the problems. `takes` and `check` are the host's: nothing about a job is in the package.
- `readUses`, `collectUses`, `usesSource` and `proposeLearning` take `served`: each served run is a use of its own revision under its name with the host's verdict, though the run's own store need not hold that revision. A canary's uses never count toward the trial.
- `servingRevision(trial, { unrunnable })` and `readRevision(repo, name, sha256, ref)` are the two pieces `planServing` stands on, for a host that serves on its own terms. `trialFirstText({ name, served, trial })` is what the agent is told when a canary does not finish: the trial is named and asked to run first, the job done by hand only if it escalates too.
- The `<learned>` section's workflows line, when one of them is on trial, adds that a workflow on trial earns trust only from its own clean runs: run it before doing the job by hand, and change it only after it escalates or fails.
- A trial is promoted after 2 clean runs in a row by default, not 3 (`PROMOTION_DEFAULTS.promoteAfter`); demotion stays after 2. A host that wants more sets `usesSettler({ thresholds: { promoteAfter } })`, as `examples/agent-learn` does with 3.
