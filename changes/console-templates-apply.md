---
packages: repo
kind: feature
---
The console has a Templates page (#/templates, in the sidebar). It lists the server's templates (GET /v2/templates): each one's name, version, description, and what it needs and makes (keys by name, MCP servers, triggers, budget a run, harness, model tier). A template's Apply screen (#/templates/<name>) takes its parameters as typed, and the owner's consent one MCP tool at a time: nothing is granted until it is ticked, and a tool that asks to run as allow says the agent may call it without asking. Apply sends POST /v2/templates/{name}/apply with the ticked tools as `grants`, under one Idempotency-Key that a retry reuses. A refusal shows the server's words at its field: a parameter's under its input, a grant's at its tool, and a 409's `fix` at the key or MCP server it names. A made agent opens at once; with warnings, they show first, with a link to the agent.
