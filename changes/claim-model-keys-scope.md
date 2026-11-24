---
packages: @parcha/agentrun-serve
kind: fix
---
A run's claim now lays its model keys where only a read by name finds them. A copy or spread of the tools' environment, and every process a tool spawns from it (the browser, the CLI tool plane, a workflow's call nodes), no longer carries the server's model key; the run's own route still reads it by name. A run's own process is now handed its pinned model's key alone: before, it also got a second claim's key, its revision's model's or the host's default's at the time of the hand-off, which could be another provider's saved since the run started. A `--faux` start still gets its revision's model's key, as before.
