---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
A Composio preset server saved with `user_id: "per_run"` keeps no account. Each run names one in `mcp_auth.<server>` as `{composio_user_id, connected_account_id?}`, sealed in the run's launch and erased at its end; a binding to the preset's default user `agentrun` is refused `422`. A run that names none has its calls refused unsent. Such a server makes no Composio trigger.
