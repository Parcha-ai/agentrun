---
packages: @parcha/agentrun-serve
kind: fix
---
An agent's `learned_workflow` call that the run's gate refuses (the tool set to deny, a person's deny of its ask, or the cap's wrap-up) is now on the run's `workflow_calls`, as the agent's, with outcome `refused` and `usd` 0, on pi and on every CLI harness. Before, it never reached the tool, kept no record and dropped out of `workflow_calls` and the learning ledger. A run whose learned calls were all refused ran no workflow: its `path` is now `agent` and it names no `workflow`, where it read `handed_back` with none. A Postgres open refused because an applied migration's text differs from this build's now names both files, the applied one and this build's, each with the start of its sha256, so a renamed or renumbered migration is plain to see.
