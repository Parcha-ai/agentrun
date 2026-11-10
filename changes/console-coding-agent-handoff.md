---
packages: repo
kind: feature
---
The console hands an agent to your own coding agent. "Build with your coding agent" on the agents list, "Edit with your coding agent" on an agent's page and "Run with your coding agent" in its run bar open a dialog where you pick Claude Code (app or CLI) or Codex (app or CLI), read where to paste, then review, edit and copy a prompt. The prompt names the public `agentrun-serve` skill, this server's `llms.txt`, OpenAPI document, capabilities and MCP endpoint, the route the task uses and its context (the agent and its revision, and for a run the input and effort typed so far); it holds no credential, since the coding agent signs in to the server on its own. Copying sends nothing and opens nothing. When the browser refuses the clipboard, the prompt is left selected with a word to copy it from the keyboard. The browser keeps only the application you picked. On a phone the list's and the header's buttons show their icon alone, and the run bar has none.
