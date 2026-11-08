---
packages: @parcha/agentrun-serve
kind: feature
---
A template package may say how its agent runs: `approvals: never` (unattended) or `ask` (the default). `GET /v2/templates` shows it as `approvals_default`. code-review, inbound-lead, market-monitor and release-notes run unattended, and kyb asks. Their writes are held by their pins (release-notes' draft issue is now pinned to `method: create`), or by a rule the template tests state. Until the agent store's cutover an agent keeps no pin of its own, so apply makes a pinned write `deny`, with a `pins.<tool>` warning, unless the server's own settings pin that tool. A template never grants a write that runs without its pin.
