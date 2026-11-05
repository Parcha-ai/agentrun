---
packages: repo
kind: fix
---
The agent's Analytics tab no longer shows a run that just ended as unknown (no effort, 0 tokens, cost Unknown) until a reload. It reads its figures again when it opens, when a run of the agent that was going changes status (followed on its timeline, as the Runs tab follows its latest run), and a few times more, briefly, while the server's `runs.status_unknown` says a run's end is not in its store yet. Mission Control's agent picker now scopes everything below it: with an agent picked, "Runs per agent" shows that agent's row alone and "Recent runs" that agent's runs alone; with All agents both list every agent, as before.
