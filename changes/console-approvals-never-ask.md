---
packages: repo
kind: feature
---
An agent's Approvals, in the console. The editor's Tools step offers Ask me or Never ask (run unattended), sent as the definition's `approvals`. Never ask says what it grants: every tool the agent has runs without waiting for you, while a tool set to deny and a template's pins still hold. While it is on, a tool row whose permission is ask says it runs without asking. An agent that never asks reads Unattended on its page, and so does each run it starts (the run's `approvals`). A template's Apply screen offers the same choice, Ask me unless you pick Never ask, sent as `overrides.approvals`.
