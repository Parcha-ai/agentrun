---
packages: @parcha/agentrun-serve
kind: feature
---
A template package may say how its agent runs: `approvals: never` (unattended) or `ask` (the default). `GET /v2/templates` shows it as `approvals_default`, and an apply takes it when it sends no `overrides.approvals`. code-review, inbound-lead, market-monitor and release-notes run unattended, and kyb asks. Their writes are held by their pins (release-notes' draft issue is now pinned to `method: create`), or by a rule the template tests state. Until the agent store's cutover an agent keeps no pin of its own, so apply makes a pinned write `deny`, with a `pins.<tool>` warning, unless the server's own settings pin that tool; that server pin then holds the agent's calls, and removing it lifts the hold until the cutover keeps the agent's own pin. A write a template offers for the owner's grant is either pinned or bounded by a rule its tests state (code-review's pending-review comment adds only to the pinned review).
