---
packages: @parcha/agentrun-serve
kind: fix
---
Keep SDK agents with omitted learning settings off. Only explicitly enabled workflow learning falls back to notes when the backend has no workflow bridge; starting a run does not change the saved agent definition.
