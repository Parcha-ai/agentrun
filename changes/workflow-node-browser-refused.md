---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow whose model node names `browser` is refused when it is saved (422), in the words any node tool this server doesn't give is refused in, instead of being accepted and then failing at its run (#2098). Capabilities' `workflows.node_tools` no longer lists `browser`, and the browser tool's `nodes` reads false.
