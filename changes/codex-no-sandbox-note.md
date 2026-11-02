---
packages: @parcha/agentrun-codex
kind: fix
---
A Codex session no longer tells the model its files are read-only. Codex sent a `<permissions instructions>` developer message ("`sandbox_mode` is `read-only`: The sandbox only permits reading files") about its own sandbox, which binds only its built-in tools, and those are off. The host's tools write. A model that believed the message refused to write at all and ended its turn with no tool call. The adapter now sets `include_permissions_instructions = false`. Codex's sandbox itself stays read-only.
- A model Codex's catalog marks multi-agent V2 (luna, sol) is no longer told it can spawn sub-agents. `multi_agent = false` turns off only V1, so Codex still built V2's collaboration tools, which the model proxy dropped, and sent `<multi_agent_role>` and `<multi_agent_mode>` messages describing them. The config now sets `[agents] enabled = false`, which turns off both versions.
