---
packages: @parcha/agentrun-serve
kind: feature
---
Applying a template says beforehand when a GitHub tool it grants is one Connect GitHub's App can't use. The App asks for the least its templates need (issues: read), so release-notes' one write, `mcp:github/issue_write`, which needs issues: write, is refused by GitHub at every call. Where the github MCP server runs on the App's tokens, the apply answer now carries a warning under `grants.mcp:github/issue_write` (`not_set_up_here`): "This server's GitHub App can read issues but not write them: release-notes keeps its draft in its answer." The console's Templates screen shows it with the apply's other warnings. The App's permissions are unchanged.
