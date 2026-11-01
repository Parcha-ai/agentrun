---
packages: @parcha/agentrun-dsl
kind: breaking
---
The DSL's command line is `agentrun-dsl`, no longer `agentrun`: `agentrun-dsl demo`, `agentrun-dsl inspect workflow.json`, `agentrun-dsl dry-run`, and so on, with the same commands and options. A script or shell that calls `agentrun` from `@parcha/agentrun-dsl` calls `agentrun-dsl` instead. The `agentrun` name is left for the AgentRun server.
