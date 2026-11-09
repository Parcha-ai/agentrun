---
packages: @parcha/agentrun-serve
kind: fix
---
A run on the runner is held to the tool gate's rules as a run in its own process was: a pinned MCP tool's call outside its pin is refused before it is asked or sent; a deny's refusal says where it was set (this server, or this agent) and that nothing was sent or charged; and with the server's stored tool settings unreadable, approvals "never" lifts no ask and no harness's own search is turned on. An approved call is checked again before it runs: a deny or a pin the server set while it waited refuses it, with that refusal's words, and it is not run. A permission set while a run goes reaches its next call: the runner reads the server's tool settings from the store at each call, and a read that fails holds the gate to its last good read with no ask lifted. Upgrading: nothing to do.
