---
packages: @parcha/agentrun-serve, repo
kind: fix
---
The OpenAPI document requires `tools` in the answer to GET /agents/{agent_id}, which the server always sends (an empty list before the agent has a revision). The agent in a list, a create or a save holds no tools, so the shared Agent schema is unchanged; that one route's answer is the Agent with `tools` required, marked `agenttools/1`. The console's generated types follow.
