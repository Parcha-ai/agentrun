---
packages: @parcha/agentrun-serve
kind: fix
---
Capabilities' `features.claude_login` and the Claude Code login routes now read one answer, so they can't disagree. In Settings → API Keys, a login turn-on or turn-off that answers after capabilities hid the row no longer puts the row back.
