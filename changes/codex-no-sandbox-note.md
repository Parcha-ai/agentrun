---
packages: @parcha/agentrun-codex
kind: fix
---
A Codex session no longer tells the model its files are read-only. Codex sent a `<permissions instructions>` developer message ("`sandbox_mode` is `read-only`: The sandbox only permits reading files") about its own sandbox, which binds only its built-in tools, and those are off. The host's tools write. A model that believed the message refused to write at all and ended its turn with no tool call. The adapter now sets `include_permissions_instructions = false`. Codex's sandbox itself stays read-only.
