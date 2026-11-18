---
packages: @parcha/agentrun-serve
kind: fix
---
An imported session its source did not price, such as a Codex session, now reads at the model catalog's estimate the import kept for it, wherever a run's cost is shown: the run's `cost.usd` (basis `estimate`, "$0.0016 est." in the console), the runs list, its timeline's usage row ("Cost: $0.0016 est. over 2 model requests"), `GET /stats` and its analytics (the cost tile and the per-harness rows), and `GET /usage`. The run's stored cost stays unknown, a recorded cost always wins, and a session the catalog cannot price stays unknown. An imported run's usage row now says the run's own cost: a Claude Code session priced at $0.0421 read "$0 known, 4 not priced" there.
