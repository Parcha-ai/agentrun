---
packages: @parcha/agentrun-serve
kind: fix
---
The root `compose.yaml` now requires `AGENTRUN_SEAL_KEY` (the README's steps write one into `.env`). Before, it passed none, so
recreating the container made a new seal key and lost every saved secret.
