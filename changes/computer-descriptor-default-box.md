---
packages: @parcha/agentrun-computer
kind: feature
---
A provider descriptor can set `defaultBox: true`: its sandbox is the box a server gives a new agent that names no place and needs a shell. Docker's descriptor sets it, and one provider at most may. Where that box is not available, a server gives such an agent no other box in its place. AgentRun's server reads this fact instead of naming a provider.
