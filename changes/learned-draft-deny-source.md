---
packages: @parcha/agentrun-serve
kind: fix
---
Fixes a learned workflow draft that calls a tool the agent's own tool settings deny being left out "set to deny on this server". The words now name where the deny was set: "set to deny for this agent" for the agent's tool settings, "on this server" for the server's. The same holds when an owner restores a draft or makes a learned workflow an agent.
- Upgrading: nothing to change.
