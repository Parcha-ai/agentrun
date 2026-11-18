---
packages: @parcha/agentrun-serve
kind: feature
---
Outbound webhook messages name their agent, so a receiver no longer reads the trigger or the agent back to know whose it is. `trigger.failed` adds `agent_id` and `agent_name`: the agent the trigger runs as, which every trigger has (a `start_run` target's agent, or the agent of the run a `message_run` target names). `run.ended` and `run.needs_input` add `agent_name` beside `agent_id`. `agent_name` is the agent's name as the message is built, or its id when it has none. The change is additive: no field is removed or renamed, and a message still carries no run output or input.
