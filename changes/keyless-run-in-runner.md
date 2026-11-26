---
packages: @parcha/agentrun-serve
kind: fix
---
A run that sends no model key (held because its model can't run, on a `--faux` start, or pinned to the faux model) now opens no saved key it never sends on any path, including runs that run inside the runner. A claude-agent run of that kind no longer reads the Claude login's setting. On a `--faux` start, a subagent, learned-workflow or grader tier no longer opens any saved key, and neither does an SDK run's compile turn; that turn is also no longer skipped for want of a gateway key, since the faux model sends none. A run's own model key handed at its start is not opened for such a run. The check that a server holds a gateway key now reads that key alone. A run with decision nodes opens the gateway's key for them only when its decisions would use it. A run's Composio connected-account check now asks Composio nothing for a blank user, which it treats as having no account.
