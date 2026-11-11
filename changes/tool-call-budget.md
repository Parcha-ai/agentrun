---
packages: @parcha/agentrun-serve
kind: feature
---
An agent can now cap its tool calls: `max_tool_calls: N` on the definition (a template's `budget.tool_calls`) gives each conversation of a pi run N tool calls. Past N, the run's tool gate refuses every further call with one fixed message telling the model to stop calling tools and answer from what it has. That refusal is not counted, and the run is never ended by it, so the model's final answer still lands. The count is read from the conversation's journal, so a restart or a moved claim keeps it, and a conversation a tool opens counts its own calls. An edit that leaves the field out keeps it, 0 clears it, and on another harness the save is refused.
- Upgrading: nothing to change; an agent with no budget runs as before.
