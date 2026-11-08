---
packages: repo
kind: fix
---
`render.yaml` generates `AGENTRUN_SEAL_KEY` as it generates `AGENTRUN_TOKEN`. A service made from the blueprint can now save model and tool keys, MCP server credentials and webhook trigger secrets from its first start, with no key added by hand. A service that already has `AGENTRUN_SEAL_KEY` keeps its own value.
