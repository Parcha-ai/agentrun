---
packages: @parcha/agentrun-serve
kind: fix
---
Applying a template grants only the MCP tools the owner ticks. A tool left unticked is not given to the agent at all, so no harness offers it and a call of it is refused before it reaches the MCP server.
- Before, an apply gave the agent every tool of each saved MCP server the template uses and set only the ticked ones to allow. Under approvals `never`, which four of the five bundled templates default to, the unticked tools then ran unasked too.
- `never` only skips asking for a tool the agent was granted. To use a tool left unticked, grant it later in the agent's tools.
- A template's pin on a tool is still written when the tool is unticked, so it holds if the owner grants the tool later.
- The apply's GitHub App permission warnings name only the tools the owner ticked.
- The console's apply screen says that an unticked tool is not given to the agent.
- Under approvals `ask` too, an unticked tool is no longer offered and asked about on each call: it is not granted.
- An agent applied from a template before this release may still hold every tool of its MCP servers. Review its tools (or apply the template again) and remove the ones you did not mean to grant, above all on an agent set to `never`.
