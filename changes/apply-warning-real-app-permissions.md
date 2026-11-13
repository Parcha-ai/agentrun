---
packages: @parcha/agentrun-serve
kind: fix
---
Applying a template that grants a GitHub tool (release-notes' `issue_write`) on a server whose GitHub MCP server runs on the GitHub App now warns from the App's real permissions, not from what its manifest asks for. Apply reads each installation's own permissions map from GitHub (`GET /app/installations/{id}`), says per tool and per account what is missing ("has Issues: read on acme"), and says nothing when the installation holds it. When the map cannot be read (no App connected, none installed, GitHub out of reach), the warning says the check could not be made (`reason: not_set_up_here`) and never states that GitHub refuses the tool. Before, an App whose settings showed Issues: read was told it could not write issues even where the call went through.
