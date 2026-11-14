---
packages: @parcha/agentrun-serve
kind: breaking
---
An MCP tool's name is held to one rule wherever it is taken: `mcp:<server>/<tool>`, the server's name in lowercase letters, digits and `-` (at most 32, starting with a letter), the tool's in letters, digits, `_` and `-` (at most 64). The tool settings (`PUT /settings/tools`, an agent's `tool_settings`), a learned workflow's call nodes, a template's `mcp` tools and its eval fixtures now refuse a name the grant always refused (a `.` in a tool's name, a tool's name over 64 characters, a server's name with capitals, `_` or `.`), where before they took it and the agent could never be granted it. Who breaks: a settings key or template naming such a tool, which now gets 422 `not_allowed`; rename it to the server's listed name, or drop it, since no run could call it. Composio actions (`GITHUB_CREATE_AN_ISSUE`) are unaffected.
