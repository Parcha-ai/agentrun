---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex, @parcha/pi-durable-agent
kind: feature
---
A run near its spend cap is told once to finish: when what is left is under three times its typical request (the median of the run's own model's priced requests after the first), the model's next request carries "About $X left of this run's budget: finish now with your answer.", and the Timeline shows it as the server's row. On pi it goes into that request's context; on claude-agent, codex and opencode the model proxy adds it to the request's body after everything the CLI sent, so the cached prefix is unchanged. No message is queued, so nothing runs after the model's answer. Once per cap, across restarts; a raise re-arms it.
