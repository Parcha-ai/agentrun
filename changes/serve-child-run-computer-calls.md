---
packages: @parcha/agentrun-serve
kind: fix
---
A run started by `agentrun-serve` (each run a process of its own) kept no `computer_calls` on its tool rows: neither a computer tool's row nor the row of each call a code-mode script made through `computer` or `tools.computer_*`. The calls were recorded in the runner's process, which saw each one arrive over the run's channel outside any tool call. The run's own process now records them, so each tool row carries its calls again (method, outcome, time, and each `ui.act` step's kind and route), and computer-bench counts steps, acts and routes from a served run.
