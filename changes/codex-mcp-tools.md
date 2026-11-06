---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-harness-codex
kind: feature
---
Agents on codex call a saved MCP server's tools: grant `mcp:<server>/<tool>` in `definition.tools`, as on pi and claude-agent, and `features.mcp_client.harnesses` now lists codex. The harness writes each granted server in Codex's `mcp_servers` itself, at the session's model proxy (`/mcp/<server>`, behind the session key), with only the granted tools enabled and approve mode, so Codex never holds the credential. The proxy records each call in the session before it sends it, by Codex's own call id, so a call a crash cut off is answered interrupted and never sent again. A server that does not start fails the turn (`required`). The Codex proxy policy admits the granted tools in the `mcp__<server>` namespace Codex 0.164 sends them in, and the timeline reads `<server> · <tool>`.
