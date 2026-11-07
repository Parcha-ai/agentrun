---
packages: @parcha/agentrun-serve
kind: breaking
---
Every run's box now has the run's `work/` at `/workspace`, where it had it at `/run/agentrun/run/work`; a tool or a prompt that named the old path names `/workspace`.
A Docker box binds that one folder of the agent's disk (`<data>/disk/agents/<key>/runs/<run>/work`) and nothing else of the data directory.
Under compose it gets the same folder as a subpath of the data volume.
A Docker box is labelled with the epoch of its run's claim (`agentrun.epoch`).
A run's process destroys every box of its run of an earlier epoch, or with none, before it makes its own or before a file tool works on the run's files; it never takes such a box over, and the model's next box tool answer starts, once, with "this run's box was replaced after a restart: /workspace is kept; packages installed outside it and /tmp are gone; reinstall what you need".
A process that finds a box of a later epoch no longer holds the run, and refuses.
A kept remote box (Daytona, the VM box) made with the old path is copied back from it, whole, then destroyed and made again at `/workspace`.
