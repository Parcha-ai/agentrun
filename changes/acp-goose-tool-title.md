---
packages: @parcha/agentrun-harness-acp
kind: fix
---
The ACP adapter ties a call of an AgentRun tool by the title Goose 1.59.2 gives it, `agentrun: <tool>` with the tool's underscores as spaces (`agentrun: check echo`). Before, such a call's permission request reached the host's gate as Goose's own call (`acp_other`) and the gate was asked twice for one call; now the request is answered allow_once and the gate is asked once, at the MCP call. A spaced title ties only under the `agentrun` server's exact name and only to the one tool it spells: another server's tool named like ours (`github: look up`, `agentrun-github: look up`) is still the agent's own.
