---
packages: @parcha/agentrun-serve
kind: docs
---
The server's README no longer says the owner's session binds a per-run Composio server to any user. It binds any user but the preset's shared default `agentrun`, which every caller gets `422 not_allowed` for, as the API reference already says.
