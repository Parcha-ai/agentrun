---
packages: @parcha/agentrun-serve
kind: fix
---
Console: a GitHub App MCP server saved without headers no longer reads "no credential" with a missing Headers row and a Paste button. Its row says GitHub App, since the App signs a token for each run; a Headers row shows only once optional headers are saved.
