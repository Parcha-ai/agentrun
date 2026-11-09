---
packages: @parcha/agentrun-serve
kind: fix
---
A run on the runner is held to the tool gate's rules as a run in its own process was: a pinned MCP tool's call outside its pin is refused before it is asked or sent; a deny's refusal says where it was set (this server, or this agent) and that nothing was sent or charged; and with the server's stored tool settings unreadable, approvals "never" lifts no ask and no harness's own search is turned on. Upgrading: nothing to do.
