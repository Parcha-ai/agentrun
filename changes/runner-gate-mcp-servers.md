---
packages: @parcha/agentrun-serve
kind: fix
---
On the runner, the tool gate knows the run's MCP servers, so a harness that names an MCP tool its own way (OpenCode's `<server>_<tool>`) is held to that tool's `mcp:<server>/<tool>` settings: an agent's deny of it refuses the call, where before the name matched no setting and the call asked. An agent's MCP server named `read` with a tool `skill_file` stays that tool, never `read`'s.
