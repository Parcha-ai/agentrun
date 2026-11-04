---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/pi-durable-agent
kind: feature
---
Agents call a saved MCP server's tools on pi and claude-agent: grant `mcp:<server>/<tool>` in `definition.tools`. A save checks the name against the server's saved tools (`422` naming them). A run's first launch pins the granted tools as saved and the server's URL; its credential reaches only runs that grant one of its tools, over the run's secrets pipe. pi binds each tool in the run's process; claude-agent's own MCP client calls it at the session's model proxy (`/mcp/<server>`, behind the session key), so the CLI never holds the credential. A call follows no redirect, a crash-cut call is answered interrupted and never sent again, a moved server is sent nothing, and the timeline reads `<server> · <tool>`. `features.mcp_client.harnesses` lists the harnesses that run them. Until the tool gate lands, a grant means the tool runs.
