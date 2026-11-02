---
packages: repo
kind: fix
---
The console names an agent made since the page loaded, here or elsewhere, wherever its runs show: the runs list and a run's page read the agents' names again when they open, so a new agent no longer shows as its id until a reload. An archived agent's runs are named too; only a run whose agent is gone shows the agent's id, and a name being read shows as nothing yet, never as the id. A read that partly fails keeps the names it got.
