---
packages: @parcha/agentrun-serve
kind: docs
---
The serve README's container guide no longer warns that the root `compose.yaml` passes no `AGENTRUN_SEAL_KEY`: it passes the key from `.env` and refuses to start without it (#2199).
Upgrading: nothing to do.
