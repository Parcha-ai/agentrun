---
packages: @parcha/agentrun-pi
kind: feature
---
The `agentrun` tool dry-runs the inspected workflow: its `dry-run` action (with an optional `input`), the `/agentrun dry-run` command and the inspector's Dry-run action run it on synthetic values, with no model, Jev or tool call, no run journal, and the last run's receipt left as it was. The result's `status` is `passed`, `not_run` (a check could not run and `skipped` says why; it proves nothing) or `failed` (`problems` say why). A workflow with code nodes is `not_run` until the user issues `/agentrun dry-run --trusted`, and a code node that throws is reported by its label, without what it threw. The tool's parameters gain the `dry-run` action, and the packaged skill tells the agent to dry-run a workflow before it runs it.
