---
packages: @parcha/agentrun-serve
kind: fix
---
A connected agent's held draft is now revised as its hold says. Before, its run's end never found the held workflow (the task never matched it as the run's input), so a check's hold never asked its one recompile and a hold after five give-backs stayed held for good. The held workflow is now the one the task fits, as the start reserves a check. A hold after five give-backs asks its revise only once the agent has `compile_after` completed runs of its own started since the hold, the same wait as a first compile, so a client that never sends a shadow check costs one compile per `compile_after` runs. That revise prompt says nothing was checked and there are no disagreements to show, and no longer says that nothing compiles again.
