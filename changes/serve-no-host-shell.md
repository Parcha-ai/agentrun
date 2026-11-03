---
packages: @parcha/agentrun-serve
kind: fix
---
A run's process no longer registers pi's `bash` tool. Every run now installs pi's `read`, `write` and `edit` without `bash`, and a run on another harness takes its host file tools from the same set. Models were never offered `bash` here; now the run's process does not hold it at all.
