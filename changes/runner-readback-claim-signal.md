---
packages: @parcha/agentrun-serve
kind: fix
---
A runner stopped while a run's start reads back what the run's computer mounts (the provider's read of the machine, Docker's `docker inspect`), and the provider never answers, now closes at once: the read takes the claim's signal, so the shutdown ends it, and the run is handed back with its computer let go. Before, the read held the close for its whole window and the run was left to its lease. The same holds for the read-back a run's own process's runner makes when it attaches a Mode 2 run's folder for its MCP files, and for the one a sandbox started in place of a lost one makes.
