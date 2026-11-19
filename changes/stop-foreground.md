---
packages: @parcha/agentrun
kind: fix
---
`agentrun stop` with a server in the foreground (`npx @parcha/agentrun` in a terminal) names it, "AgentRun is running in the foreground (pid N); press Ctrl-C in its terminal.", and leaves it running (exit 1), where it said no AgentRun was running. The README says Ctrl-C in that terminal stops it.
