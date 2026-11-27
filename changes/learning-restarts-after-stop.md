---
packages: @parcha/agentrun-serve
kind: fix
---
A learned workflow whose recompile's check held it (`check.stopped`) now restarts on new evidence after the stop: a correction merged into `corrections.md` after it, or `compile_after` more of the agent's own completed runs started after it. Before, nothing compiled again until its owner acted, and the only actions were a console-only re-check of the same revision or a reset of the agent's learning, so an agent's learning stopped for good after its second hold. A restart is a first compile again: one revise (attempt 1) and its one recompile (attempt 2), which stops again, and only evidence newer than that stop restarts it once more, so each restart costs at most two compiles. A recompile's failed draft and a stop with nothing to check restart the same way. The stop's reason now says what restarts it.
