---
packages: @parcha/agentrun-serve
kind: fix
---
The agent editor's tools step, with no MCP server saved, links to Settings → MCP servers instead of only naming it. On a server that sends its models to a gateway, unless its own default model is one of the plan's (`AGENT_MODEL=chatgpt/…`), the ChatGPT plan row and the first screen's sign-in no longer say Codex and pi agents run on the plan: there an agent with no model named runs on the gateway, and the plan runs only an agent that names one of its models (`chatgpt/…`).
