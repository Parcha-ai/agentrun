---
packages: repo
kind: fix
---
The console's Playground on a server with no agents shows how to make the first one. The agent picker opened a blank field over an empty list, above a form that could not send. Now a panel offers Create an agent and Browse templates, a read-only list names what a request takes, and the code samples read `/v2/agents/{agent_id}/runs` instead of a path with an empty segment.
