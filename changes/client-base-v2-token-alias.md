---
packages: @parcha/agentrun-client, @parcha/agentrun
kind: fix
---
The TypeScript and Python clients take the server's address as the CLI does: `/v2` is added to a base URL whose path holds no `v2` segment, a path prefix kept, so the same `AGENTRUN_BASE_URL` reaches the same routes from the CLI and both clients, where the Python client answered 404 before. `AGENTRUN_TOKEN`, the name the server and its setup page give the token, stands in for `AGENTRUN_API_KEY`, which wins when both are set: in both clients, and in the CLI after a token kept for the address. A local server started with its token in `AGENTRUN_TOKEN` takes it, and `agentrun deploy` reads neither variable for the install an agent comes from. The Python client `parcha-agentrun` has the same change.
