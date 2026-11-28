---
packages: @parcha/agentrun-serve
kind: fix
---
A template apply that can't find a saved MCP server for a need whose toolkit is its source's own name (GitHub's: source `github`, toolkit `github`) now names that need once. Before, it said both. This affects the `mcp.<toolkit>` warning ("No saved MCP server is github, so the agent was made without its tools …", was "github github"), a required need's `409` refusal ("needs a github MCP server", was "a github MCP server of the toolkit github") and its field, and the `servers.<toolkit>` refusals of a pick. A need whose toolkit differs from its source still names both ("url notes"). Fields, reasons and fixes are unchanged.
