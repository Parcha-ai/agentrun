---
packages: @parcha/agentrun
kind: fix
---
`agentrun deploy --agent ID|new` works when the lock names an agent that is gone from the target. `--agent ID` deploys onto that agent, `--agent new` makes another, and the lock names it after. Before, the flag was refused because the lock named another agent, though the deploy's own hint offered `--agent ID` for the package's other agent there. While the locked agent is on the target, `--agent` naming another is still refused, with nothing written.
