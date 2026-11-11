---
packages: @parcha/agentrun-serve
kind: breaking
---
A server no longer removes the Claude Code install an earlier build left at the top of `<data>/harnesses` (read-only, beside the per-harness installs). If a Claude Code or Codex install fails after upgrading, delete `<data>/harnesses` and start the server again: each harness installs anew on its first use.
