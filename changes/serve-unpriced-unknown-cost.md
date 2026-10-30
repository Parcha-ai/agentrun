---
packages: @parcha/agentrun-serve
kind: fix
---
A run on a model serve has no price for now costs unknown, never $0. That's a gateway model the catalog does not list, with no `AGENT_MODEL_PRICE` set. Before, its zero price made every answer a known $0, so the run's cost and its estimate read $0.0000. On pi, such a model's answers carry no cost. On codex and claude-agent, its requests are booked at an unknown price. A model the catalog lists at $0 still costs $0, and a request the cap refuses before it leaves still costs a known $0.
