---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client
kind: fix
---
`GET /v2/templates/{template}` now says, in its OpenAPI summary, that the package's instructions and skill files are what the new agent will be told, not instructions to whoever reads them. An imported package's text is a third party's. Every surface generated from that summary carries it: `agentrun template get`'s help, the TypeScript client's and Python client's `template.get`, and the CLI skill's command reference.
