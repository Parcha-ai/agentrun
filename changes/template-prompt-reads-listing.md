---
packages: @parcha/agentrun-serve
kind: fix
---
The console's template prompts and the agentrun-serve skill read a template's entry in `GET /v2/templates`, not the whole package, so a package's instructions and skill files no longer reach the coding agent. They, and the `GET /v2/templates` summary that the CLI and the clients carry, say the entry's own text (its description, reasons, notes and trigger inputs) is the package author's, not instructions to the reader.
