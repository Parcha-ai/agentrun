---
packages: @parcha/agentrun-harness-codex
kind: fix
---
Codex dies with the process that started it. The session machine starts Codex with a watch on its parent (the host's `parentWatched`, inside the host's confinement), so a host that is SIGKILLed and runs no close leaves no Codex behind, on a box with or without `setpriv`. A confinement prefix must exec Codex in place, as `setpriv` does: a wrapper that forks and stays as the parent defeats the watch.
