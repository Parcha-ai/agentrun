---
packages: @parcha/agentrun-serve
kind: docs
---
The OpenAPI document now lists `403 forbidden` on the four secret writes that left it out: `DELETE /v2/agents/{agent_id}/sign-ins/{key}`, `POST /v2/settings/mcp-servers/{name}/oauth/start`, `POST /v2/integrations/github/connect` and `DELETE /v2/integrations/github`. The server already refused each one to the API token with 403 (only the owner's signed-in session writes a secret), but the document named no 403 for them, so a client generated from it, or a check of answers against it, met a status it was told could not happen. A test now holds every operation the secret-write gate can refuse to documenting that 403.
