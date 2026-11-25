---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: fix
---
A Docker computer's egress proxy no longer outlives it. A delete now finds the proxy first and removes the computer and its proxy in one `docker rm`, so a teardown cut off partway (the process running it ended, as a one-shot server's close can) never leaves a proxy running with no computer. A computer whose own removal fails, on a release or after a create that was cut off or whose computer never started, still has its proxy and volume removed, and the computer's failure is still the answer. Before, a failure or an exit between the two calls left the proxy running until its 24 hour deadline.

- `sweepLeftovers` and the janitor's `sweep` take `mine`: given a leftover's labels, whether it is the caller's to remove. Without it, every leftover with the sweep's labels goes, as before.
- serve's computer janitor now sweeps Docker's leftovers at the runner's start and on its interval, for this server's alone: a proxy or volume whose `agentrun.run` label (or its hash) names a run in this store, or whose owner names this server. Another server's on the same Docker host is left for that server's own sweep.
- A release (delete) now runs `docker ps` for the proxy before its `docker rm`, and a stop looks for the proxy before it stops the computer.
