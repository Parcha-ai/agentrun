---
packages: @parcha/agentrun-serve
kind: fix
---
On a clean stop, `agentrun-serve` removes `DIR/.server.json` before it releases the data directory's lock, and only while the record still names this server (its pid), so a server started next keeps its own record. It installs its stop handlers before it writes the record.
