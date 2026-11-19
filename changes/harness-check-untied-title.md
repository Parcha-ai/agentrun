---
packages: @parcha/agentrun-serve
kind: fix
---
`agentrun harness-check`'s gate refuses every call that is the agent's own (`acp_<kind>`), as a server's gate does, so a call of AgentRun's tool whose title the adapter can't tie fails `mcp_tool` instead of passing; the report's `gate.asked` and `denied_call` drop `about` and `askedAs`.
