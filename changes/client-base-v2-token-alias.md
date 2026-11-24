---
packages: @parcha/agentrun-client, @parcha/agentrun
kind: fix
---
The TypeScript and Python clients take the server's address as the CLI does: `/v2` is added to a base URL whose path holds no `v2` segment, a path prefix kept, so the same `AGENTRUN_BASE_URL` reaches the same routes from the CLI and both clients, where the Python client answered 404 before. `AGENTRUN_TOKEN`, the name the server and its setup page give the token, stands in for `AGENTRUN_API_KEY` in both clients, which send it to the server `AGENTRUN_BASE_URL` names; `AGENTRUN_API_KEY` wins when both are set. The CLI sends `AGENTRUN_TOKEN` only to the server started on this machine with its token in that variable, which used to refuse with "set AGENTRUN_API_KEY to it"; another address still takes `AGENTRUN_API_KEY` or the token kept for it, and with neither is refused. The Python client `parcha-agentrun` has the same change.
