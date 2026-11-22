---
packages: @parcha/agentrun-serve
kind: fix
---
A connected agent's draft held after five give-backs in a row is now revised: its run's end finds the held workflow its task fits (as the start reserves a check), where before a JSON or prose task never matched it and the draft stayed held for good. The revise waits for `compile_after` completed runs of the agent's own since the hold, the same wait as a first compile, so a client that never sends a shadow check costs one compile per `compile_after` runs. Its prompt says nothing was checked and there are no disagreements to show, and no longer says that nothing compiles again.
