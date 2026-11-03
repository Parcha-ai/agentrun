---
packages: @parcha/agentrun-serve
kind: fix
---
A box this server doesn't list is no longer just "not enabled on this server": its reason says how to turn it on, for example "start AgentRun with AGENTRUN_BOXES=docker (a comma-separated list of boxes)". So someone who started AgentRun with npx, and sees Docker unavailable in capabilities, an agent's warning or the console, knows the one variable to set and that it takes a restart.
