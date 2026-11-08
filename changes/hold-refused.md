---
packages: @parcha/agentrun-serve, @parcha/pi-durable-disk
kind: fix
---
A paid tool call or a model request whose hold or start mark cannot be made durable is never left open at its figure. With no run store to sync, nothing is written and the call or request is not sent, in words that say so. When the sync fails after the hold was written, the hold is settled at $0 under its call, so the cap no longer counts a call that never left, and the model is told the hold could not be made durable, not that its mark could not be written. A start mark is ended unsent the same way.
