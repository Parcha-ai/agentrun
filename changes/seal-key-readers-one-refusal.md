---
packages: @parcha/agentrun-serve
kind: fix
---
A missing or malformed `AGENTRUN_SEAL_KEY` is refused in one wording wherever the key is read: what it guards, and the key's length, never its value.
