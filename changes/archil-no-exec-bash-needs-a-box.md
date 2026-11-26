---
packages: @parcha/agentrun-serve, @parcha/agentrun
kind: fix
---
On a Mode 2 server whose Archil region has no serverless exec (`gcp-us-central1`), the refusal of an agent with `bash` (or another shell tool) and no computer now opens with the rule: "bash needs a box (a sandbox computer): this server's Archil region gcp-us-central1 has no serverless exec, …". Before, it opened "name a sandbox computer: …". The words are the same at its save, at `agentrun deploy`, at each run of one saved before (`409 agent_not_runnable`) and in `capabilities.places.default_reason`. The field, reason and fix are unchanged. The serve and CLI READMEs now say where `bash` runs on such a region: nowhere without a box. Give the agent a sandbox computer, or leave `bash` out of its tools.
