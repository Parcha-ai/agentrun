---
packages: @parcha/agentrun-serve
kind: fix
---
The tool gate, the host tools and the MCP gateway keep only the runner's path. Their per-run-process half had no caller left after the old run engine went, so it is removed: the gate's enter, park, executor and extension members, its approval and gate-passed entries, and the kernel drive's session store (`sessions.ts`); the host tools' `hostTools()`; the coding source a run's own process bound (`coding-tools.ts`, `bound-files.ts`); and the MCP gateway's pi registrations, copied credentials and cap fallback. The server's tool settings are the store's alone: the `tool-settings.json` reader and the `ToolSettings` class are gone, and the runner's gate takes its settings and whether anyone can approve from its claim. Nothing a person or a model sees changes.
