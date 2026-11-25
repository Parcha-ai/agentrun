---
packages: @parcha/agentrun-serve
kind: fix
---

Every reader of the server's seal key (tool keys, the server's own secrets, MCP servers' credentials, a runner, an import) now refuses a missing or malformed `AGENTRUN_SEAL_KEY` in one wording: what is kept under it, and the one handed by its length, never any part of its value.
