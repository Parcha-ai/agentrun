---
packages: @parcha/agentrun-serve
kind: fix
---
A VM box program whose start was still waiting on the provider when its run ended is now let go as soon as it starts. The server no longer reads its output or keeps it for ten minutes, and the run's process gets a 410 saying the run ended while the program started.
