---
packages: @parcha/agentrun-serve
kind: fix
---
On claude-agent, codex and opencode, a side call the CLI makes (a title, a summary) while the spend cap's wrap-up note is on its way to the model no longer makes the run tell the model twice: the note stays recorded as told, with one Timeline row.
