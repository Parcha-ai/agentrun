---
packages: repo
kind: docs
---
New example `examples/agent-learn/`: an issue-triage agent that learns in its own git repository, end to end in one command
with a scripted model and judge (`npm run demo:learn`, no key, no network). The agent's `AGENTS.md` says
to call `learn` with type correction when a maintainer corrects it. In run 1 a maintainer gives a project rule no model can
guess; the host proposes the note on `runs/run-1`, and curation merges it to `main`. Run 2's first model request carries it
in `<learned>`; run 2 applies it, marks it used, and saves a workflow with the DSL's `agentrun` tool, which curation admits
as a trial skill. `retireLearning` then takes the rule out (a `git revert` would conflict once the rule was used), so run 3
labels without it and is offered the trial, and a run that tries to keep a host secret proposes nothing.
`host.mjs` is the reference host loop over `@parcha/pi-git-remote`, `@parcha/pi-agent-learn` and
`@parcha/pi-durable-agent`: `prepareRun` (fetch main, refresh the agent home at its sha with a compare-and-swap, start the
run there, seed its section and its trials), `finishRun` (carry back, then propose notes, saved workflows and uses) and
`curateNow` (the judge is the DSL's `runJudge` port). `--live` runs the triage runs on a model at an OpenAI Responses
endpoint.
