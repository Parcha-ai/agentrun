---
packages: @parcha/agentrun-serve
kind: fix
---
A run on the runner lists its agent's learned workflows again: the claim reads them from the agent's learning folder at the commit the run's learning start pinned, in the same read that lays its notes and learned skills, and its `learned_workflow` tool names each active one. A pending or retired workflow, one holding a key saved on the server (said in one line of the run's log), or one over the tool's description budget is left out, as on the server. Before, a runner run listed none, since only the server wrote the run's learning pin. A run's seed now reads its learned workflows at its seed's commit even while a write to the learning folder is in flight, where the server's start used to give it none. Upgrading: nothing to do.
