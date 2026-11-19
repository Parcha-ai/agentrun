---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: fix
---
The SDK compile prompt calls a learned workflow compiled and unchecked and no longer tells the agent to prefer it: the agent decides whether one fits under its original instructions and permissions. The client's workflow context now opens "Compiled workflows for this task (not checked):".
