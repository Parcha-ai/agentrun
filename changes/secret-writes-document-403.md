---
packages: @parcha/agentrun-serve
kind: docs
---
The OpenAPI document now lists `403 forbidden` on the four secret writes that left it out: `DELETE /v2/agents/{agent_id}/sign-ins/{key}`, `POST /v2/settings/mcp-servers/{name}/oauth/start`, `POST /v2/integrations/github/connect` and `DELETE /v2/integrations/github`. The server already refused each one to the API token.
