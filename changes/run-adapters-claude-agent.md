---
packages: @parcha/agentrun-harness-claude
kind: feature
---
The harness takes the MCP library a host loaded (`mcp`, passed to its tool server) and exports `claudeAgentPlatform()`, the suffix of the Claude Agent SDK's CLI package for this machine. A host can now install the Claude Agent SDK on first use and load it from its own directory; this package still ships none.
