---
packages: @parcha/agentrun-serve
kind: feature
---
On AgentRun Server's page an ended run has **Copy answer** (a completed run's whole answer, from `GET /v2/runs/{id}`, as plain text) and **Run again** (an agentic run: a new run of the same revision with its first message, then its page; off when the timeline cut that message, and absent on a workflow run, whose input the page does not hold). A refusal reads in words, "This agent can't run here: …" or "Some of it needs a change." with the fields as the form names them (`model`, not `definition.model`), and no HTTP status.
