---
packages: @parcha/agentrun-serve, @parcha/agentrun-dsl
kind: fix
---
A run's model requests, paid tool calls and workflow effects are durable before they are sent, ready for a run store that syncs between commits: serve syncs the run's store after a model or compaction request's start mark, after every paid call's hold (paid requests, monid.run and priced MCP calls, written by one helper), and after a workflow effect's admission. A sync that fails sends nothing. The dsl's recovery driver takes an optional `afterAdmit` hook, called after each effect's admission and before its dispatch; a host whose journal needs no barrier leaves it out.
