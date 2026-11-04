---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: feature
---
A run's timeline says when its process resumed it: "Resumed after a crash" when its last process died holding it and the server relaunched it, or "Resumed after the server stopped" when it drained at a stop and the next start opened it again. The row comes from an entry the new process writes on the run's root as it opens (`RUN_RESUMED`, exported by `@parcha/pi-durable-agent/timeline`), so it stays once the run ends, on pi, claude-agent and codex alike. A first open, a follow-up and a wake from a park write none. A reader from before this ignores the entry.
