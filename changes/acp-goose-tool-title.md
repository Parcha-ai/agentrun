---
packages: @parcha/agentrun-harness-acp
kind: fix
---
The ACP adapter ties `agentrun: <tool>`, the tool's underscores as spaces (Goose 1.59.2's title), to our tool, so the host's gate is asked once per call, at the MCP call, not twice.
