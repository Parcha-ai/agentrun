---
packages: @parcha/agentrun-serve
kind: feature
---
An agent's MCP tools are pinned when the agent is saved, not at its run's first start. A save (POST /agents, PUT /agents/{agent_id}/definition, a template's apply) keeps each granted `mcp:<server>/<tool>` in the revision as the server's saved snapshot holds it, with the owner's price and the version of the server's whole tool list; every run of that revision calls those tools, whatever the server lists after a refresh. GET /agents/{agent_id} answers `mcp_drift`: each pinned server whose tools or address moved since, or that is gone. Save the agent again to pin its tools as they are now; a save that changes nothing makes no revision. A revision saved before this keeps pinning at its run's first start.
- A price the owner changes reaches an agent's runs at its next save, as its tools do.
- The meta-tool and header checks run at the save and again at every run's start.
