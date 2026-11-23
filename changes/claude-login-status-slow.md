---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-claude
kind: fix
---
A claude-agent run on Claude Code's login no longer fails when the CLI's login check is slow. On a busy machine, `claude auth status` (run in an empty home each time) can take longer than its 15 s limit. That is now read as no answer yet: the check is asked once more, and if it times out again the run goes on with the login. A signed-out login, or an answer that isn't a status, still stops the run before it starts. Runs that start together on one login share one check, and a signed-in answer stands for a minute, so a burst of runs asks the CLI once.
