---
packages: @parcha/agentrun-serve
kind: fix
---
Claude Code, Codex, workflow and learning runs now show what they cost. Before, their cost read $0 ("$0.0000 est.", a workflow's "Cost so far: $0 over 3 model requests", a learning run at $0 beside its grade's cost), because the cost was read from the run's record, whose answers carry no price on these harnesses, while each paid request was booked at its price beside it. A run's cost is now the sum of its booked requests (its model requests, a workflow's decisions, its paid tool calls, a learning run's grade): on its row, its usage row, its view and the runs list while it runs. A request whose price is unknown makes the cost unknown, with the known part and how many have no price, never $0. A workflow's view also counts its decisions now, as its stored cost already did. pi runs read as before.
