---
packages: @parcha/agentrun-serve
kind: fix
---
Applying a template: a url MCP need whose toolkit is one of the URL presets (parallel, firecrawl, github, linear, notion) now links to Settings → MCP servers with that preset filled (`&preset=<id>`, github's is `github-token`), not an empty add form under the toolkit's name.
