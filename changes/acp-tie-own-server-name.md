---
packages: @parcha/agentrun-harness-acp
kind: fix
---
Under any recipe that declares the title tie (`quirks.permissionTie`), AgentRun's MCP server now goes by a name of each start's own (`ar` and 6 random hex digits), with the default `agentrun__` prefix and Goose's permission file reading that name. Before, a recipe of the owner's own with the tie and the default prefix kept `agentrun`, so a second MCP server named exactly `agentrun` with a tool named like one of AgentRun's had its call answered `allow_once` on the tie without the host's gate, or, with Goose's permission file, run unasked. The host gate's question about a call the recipe's server field (Cursor's `providerIdentifier`) names as another server's now carries that server's name (`server`), so a call titled `agentrun-look_up: look_up` can be told from AgentRun's own. Cursor's tool names in events and meta tools now read the start's own server name, not `agentrun`.
