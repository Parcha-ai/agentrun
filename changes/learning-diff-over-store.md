---
packages: @parcha/agentrun-serve
kind: fix
---
`GET /v2/runs/{id}/learning/diff` answers again (it answered `unsupported_here`, so a run's "What it changed" box said it couldn't read it). A run its learning merged reads its merge against its parent from the agent's learning folder; one whose proposal was not merged reads its notes as added against its seed; one that proposed nothing reads no file against its seed; a run that does not learn is 404. A patch holding a value saved as a secret is withheld, and a file named for one reads `[redacted]`.
- Upgrading: nothing to change.
