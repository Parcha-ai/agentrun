---
packages: @parcha/agentrun-codex
kind: fix
---
After a crash, a host tool's call that was cut off is told to Codex by the replay policy the run's log recorded when it started, as the recovery note of the same turn tells it. Before, the output Codex got for a `safe` call said it may have taken effect, while the note said it was safe to repeat: the drive that opens after a crash marks a safe call for a retry, which the output's own rule did not count as interrupted.
