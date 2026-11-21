---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose revision ships skills no longer fails at its claim on a fresh Mode 2 (Archil) folder with `".agents/skills" is not there` when it runs in its own process. A `WorkspaceError` now crosses the run's channel as a `WorkspaceError` with its `code`, as the other run errors do, so `layOwnSkills` (and every other check of `instanceof WorkspaceError` in the run's process) reads a missing folder as `NOT_FOUND` again. Runs in the runner's process were not affected.
