---
packages: @parcha/agentrun-serve
kind: fix
---
The SDK compile prompt calls a learned workflow compiled and unchecked and no longer tells the agent to prefer it: the agent decides whether one fits under its original instructions and permissions.
