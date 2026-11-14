---
packages: @parcha/agentrun-serve
kind: feature
---
ask_person runs on Claude Code and Codex. A `claude-agent` or `codex` agent granted `ask_person` is no longer refused as pi's (`409 agent_not_runnable` with `details.unbound`, and the save's warning on the tool): the tool is bound as a host tool, its call passes the run's gate like any host tool's, and the run waits on the person as a pi run does. Its turn ends at the question, the run parks `input_required` with the question pending and the row saying "Waiting for your reply", and the person's answer resumes it as its next turn. A stop while it waits ends it stopped. `GET /v2/capabilities` lists every harness for `ask_person`.
