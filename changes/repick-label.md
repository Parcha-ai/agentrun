---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A served run's `workflow` carries `repick` (`found`, `missed` or null), read off its loop rows, and its run page says "Learned workflow · re-picked" when a quote miss re-picked the answer, or "handed back by <name> after its re-pick missed". Upgrading: a run-list row cached before this is not rebuilt, so it lacks `repick` until the run changes; `GET /v2/runs/{run_id}` has it.
