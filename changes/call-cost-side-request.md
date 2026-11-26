---
packages: @parcha/agentrun-serve
kind: fix
---
A learned workflow call's `usd` in a run's `workflow_calls` no longer counts a CLI's own side request on another model (its title or summary helper) booked inside the call's window. That request was already no proof the call spent; now it is no part of the call's price either.
