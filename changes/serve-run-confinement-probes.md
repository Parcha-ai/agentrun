---
packages: @parcha/agentrun-serve
kind: docs
---
The README's Safety section says what holds a run in: its file tools reach its own `work/` and nothing else (pi-durable-disk's confinement in the run's process, since the run and the server share a user), and no path offers a shell, so `bash` stays off. A new suite of real runs probes it: reads of the server's and the door's tokens, `store.sqlite`, another run's files, `/proc` and a link planted in `work/`, writes and an edit outside `work/`, and `bash` called by an agent and by a workflow's model node are each refused, with nothing changed on disk, while the same run still reads and writes inside `work/`.
