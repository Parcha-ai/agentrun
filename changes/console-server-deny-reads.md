---
packages: repo
kind: fix
---
The console's server-deny line reads the newest word on each tool. An MCP tool picked from its server's read, before the agent is saved, is held at deny with the line when that read says this server denies it, and the MCP picker doesn't offer it to tick. A deny lifted since the editor read capabilities no longer holds a tool the agent's read says is allowed.
