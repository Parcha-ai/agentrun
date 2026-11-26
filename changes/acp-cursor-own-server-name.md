---
packages: @parcha/agentrun-harness-acp
kind: fix
---
Under Cursor's recipe, AgentRun's MCP server now goes by a name of each start's own (`ar` and 6 random hex digits), as it already did under Antigravity's, and a call is AgentRun's only when its `providerIdentifier` says that name. Before, the server was named `agentrun`, so a second MCP server named exactly `agentrun` (in a workspace's `.cursor/mcp.json`, or the owner's own Cursor configuration) with a tool named like one of AgentRun's had its call read as AgentRun's: its permission request was answered `allow_once` on the title tie without the host's gate. Such a call is now the agent's own, and the host's gate decides it. A recipe whose `announces` reads the server from a field (`server`) gets the same. Goose's server keeps the name `agentrun`: its configuration is written whole at each start, and its proxy offers its model AgentRun's tools alone.
