---
packages: @parcha/agentrun-serve, @parcha/agentrun
kind: fix
---
The console's template prompts and the agentrun-serve skill read a template's entry in `GET /v2/templates`, not the whole package, so a package's instructions and skill files no longer reach the coding agent. They say every text in the entry (its description, parameter descriptions, MCP reasons, model notes and warnings, trigger inputs) is the package author's, not instructions to the reader, and so do the CLI's help and the clients' docs for `GET /v2/templates` and an import preview. `agentrun template install --dry-run` prints the same on stderr.
