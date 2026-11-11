---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow run shows what it cost. Its Timeline's usage row read "Cost so far: $0 over 3 model requests", because its model nodes' answers carry pi-ai's $0 for a model it has no price for, while each request was booked at its price beside them. Its usage row is now its booking's, as a Claude Code or Codex run's is: its model nodes, its `llm` calls and its paid tool calls at what they were booked at. Its decisions count once, from their receipts, on the Timeline and in the run's cost (a run's view counted none of them before). The runs list and `/v2/usage` read a running Claude Code, Codex or workflow run's booked spend, where they read $0, and an unknown booked spend reads unknown, never $0. A run that ended reads a request it left unanswered as a cost unknown on its Timeline, as its view does.
