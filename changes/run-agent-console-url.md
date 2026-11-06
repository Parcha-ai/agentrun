---
packages: @parcha/agentrun-serve, @parcha/agentrun
kind: feature
---
A run and an agent read over the API carry their page in the console, `console_url` (`consoleurl/1`): every run the API answers (`POST /v2/agents/{agent_id}/runs`, `GET /v2/runs/{run_id}`, the lists' items) has `<origin>/#/runs/<run_id>`, and every agent `<origin>/#/agents/<agent_id>`. The origin is the address people open: the server's public URL (`AGENTRUN_PUBLIC_URL`, or Render's `RENDER_EXTERNAL_URL`) when it has one, else its own address, the port it took included. A client gives a person that link instead of guessing the server's port. MCP's `runs_get` answers the route's `console_url`, now at the same origin, rather than one built from the request's `Host`. `npx @parcha/agentrun runs start` and `runs get` print it with the run.
Upgrading: nothing to do; the field is new. MCP's `console_url` no longer follows the address a client called through (a tunnel's own port, say): it is the server's own address, or its public URL.
