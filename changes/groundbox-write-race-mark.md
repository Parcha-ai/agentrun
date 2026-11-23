---
packages: @parcha/agentrun-computer
kind: fix
---
Groundbox: a write whose bytes went in is no longer reported as "the process has ended" when the command exits right after it, and a write or kill waits for the start's own readiness line, so a wrapper's warning on stderr no longer lets one go before the command's directory is made.
