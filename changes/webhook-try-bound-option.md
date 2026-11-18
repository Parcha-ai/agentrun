---
packages: @parcha/agentrun-serve
kind: feature
---
A webhook try's bound can be set: `Webhooks`' `timeoutMs` option, and the server's `webhookTimeoutMs` (15 s by default, as before). It is refused at zero or at or past the 60 s claim a try holds its message by, so no try outlives its claim. A try cut by it says the bound it had (`no answer in <n> s`).
