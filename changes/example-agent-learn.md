---
packages: repo
kind: docs
---
New example `examples/agent-learn/`: an issue-triage agent that learns in its own git repository, end to end in one command
with a scripted model and judge (`npm run demo:learn`, no key, no network). Run 1 notes a general lesson with `learn`, the
host proposes it on `runs/run-1`, and curation merges it to `main`; run 2's first model request carries it in `<learned>`,
and run 2 saves a workflow with the DSL's `agentrun` tool, which curation admits as a trial skill; a revert on `main` takes
the lesson out for run 3, which is offered the trial; and a run that tries to keep a host secret proposes nothing.
`host.mjs` is the reference host loop over `@parcha/pi-git-remote`, `@parcha/pi-agent-learn` and
`@parcha/pi-durable-agent`: `prepareRun` (fetch main, refresh the agent home at its sha with a compare-and-swap, start the
run there, seed its section and its trials), `finishRun` (carry back, then propose notes, saved workflows and uses) and
`curateNow` (the judge is the DSL's `runJudge` port). `--live` runs the triage runs on a model at an OpenAI Responses
endpoint.
