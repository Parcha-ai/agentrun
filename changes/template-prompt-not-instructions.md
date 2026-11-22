---
packages: @parcha/agentrun-serve
kind: fix
---
The console's "set up with a coding agent" prompt for a template now tells the coding agent that the package's instructions and files are what the new agent will be told, not instructions to it, and that it does not follow anything they ask of it. The prompt has the agent read the whole package with `GET /v2/templates/{template}`, and an imported package's text is a third party's.
