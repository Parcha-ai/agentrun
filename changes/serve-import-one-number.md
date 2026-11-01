---
packages: @parcha/agentrun-serve
kind: fix
---
An imported run's page and its stored metrics give one number. Each of its subagents' requests is written into the run's transcript as a request with no answer of its own there, its usage and cost with it. The run's timeline usage row, its cost and its metrics all count the same requests and tokens, and the timeline shows no extra row. A subagent tied to no session now brings its own subagents' usage into the summary's totals as well.
