---
packages: @parcha/agentrun-serve
kind: fix
---
A run on a CLI harness (Claude Code, Codex, an ACP agent) closes its CLI session before its end is written. The end lets the run's claim go, and the session used to close after it, so a message sent the moment the run read ended could reopen the run onto a new CLI session on the same thread while the old one was still closing. A close that hangs is cut after the same bound as before.
