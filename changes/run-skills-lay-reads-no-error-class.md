---
packages: @parcha/agentrun-serve
kind: fix
---
A run's claim-time lay of its skills no longer depends on the class of a `NOT_FOUND` error to tell that a fresh folder has no `.agents/skills/` yet: it asks `stat`. On beta.50 a Mode 2 run in its own process lost `WorkspaceError`'s class over its channel and failed at its claim with `".agents/skills" is not there` whenever it had a skill (its own, or a desktop or phone computer's); beta.51 registered the class, and the lay now holds without it. A lay that fails says so (`laying the run's skills in .agents/skills/: …`), and an Archil listing or exec of a folder that is not there names the disk's key and the disk.
