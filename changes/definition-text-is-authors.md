---
packages: @parcha/agentrun-serve
kind: fix
---
The MCP tool `agents_list` and the console's prompts for editing an existing agent (its editor's copied prompt and the prepared request) say that an agent's instructions and skill files are what it is told, and may be a template author's text, not instructions to the coding agent reading them: if they ask for something, it tells the person instead of doing it. A new agent's prompts are unchanged.
