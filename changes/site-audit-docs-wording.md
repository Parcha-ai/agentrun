---
packages: @parcha/agentrun-dsl, @parcha/agentrun
kind: fix
---
A node with an unknown key now reads "unknown key(s) for an agent node" (and "an artifact", "an escalate", "an extract" node); it said "a agent". The CLI's flag help and `references/commands.md` now give a flag's whole first paragraph, so `--idempotency-key` no longer stops at "replays the first", and the command reference writes the wildcard media type as `*/*` instead of losing it to Markdown emphasis.
