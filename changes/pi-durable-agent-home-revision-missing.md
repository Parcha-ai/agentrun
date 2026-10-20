---
packages: @parcha/pi-durable-agent
kind: fix
---
`homeRevision(home, { access })` fails with `AgentHomeError` (`missing`) when the directory the access claims holds no `agent.sqlite`, as `readAgentHome` already did. It opened the store without checking and threw SQLite's "unable to open database file". Without `access` it was already `missing`.
