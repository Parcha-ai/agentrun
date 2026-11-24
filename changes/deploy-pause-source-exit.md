---
packages: @parcha/agentrun
kind: fix
---
`agentrun deploy AGENT_ID --pause-source` exits 1 when it could not turn off every schedule of the agent on its install, and says so after the line that says the deploy landed. The deploy stands: the new agent is live, its lock is written and its answer is on stdout. Before, it exited 0 with a warning, as if the source were paused.
- An install's trigger list that answers 2xx with no JSON, or with no list of triggers, is read as unread, never as no schedules, and the warning says why (`200 with no JSON`). Without `--pause-source`, the command still exits 0 with the warning.
