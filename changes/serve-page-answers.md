---
packages: @parcha/agentrun-serve
kind: feature
---
On AgentRun Server's page an ended run has **Copy answer** (a completed run's whole answer, from `GET /v2/runs/{id}`, as plain text) and **Run again** (a new run of the same revision with the run's input, then its page). `GET /v2/runs/{id}/input`, this server's own route outside the contract and named in `capabilities.features.run_input`, answers `{input}`: a run's input exactly as it was started, agentic or workflow, whole, where the timeline cuts a long first message at 2,000 characters. A refusal reads in words, "This agent can't run here: …" or "Some of it needs a change." with the fields as the form names them (`model`, not `definition.model`), and no HTTP status.
