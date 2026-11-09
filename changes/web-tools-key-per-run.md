---
packages: @parcha/agentrun-serve
kind: fix
---
On the runner, the web tools read the Parallel key from each call, and no client, key or fetched page outlives its run: one run's key or pages never serve another's. A run's monid price quotes are its own too.
