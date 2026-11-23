---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
A run read whose costs were counted without the purge gate's answer now says so with `cost.degraded: true` (absent on every other read), and a learning folder that fails to close after the gate's ask is logged wherever the gate is asked, never dropped.
