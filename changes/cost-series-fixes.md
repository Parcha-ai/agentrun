---
packages: @parcha/agentrun-serve
kind: fix
---
An agent's cost per run (`GET /agents/{id}/learning/cost`, `agentrun learning cost`, the console's Cost per run) now counts only the agent's own runs, and no longer shows a run as the agent's at $0 when its cost and path are not known. A follow-up's end no longer queues a learning run beside a kept learning that names none, so a `<run>-learning` row never shows up in the series as an agent run. A grade's spend stays booked as its run's `learning_usd`, inside the run's all-in cost. A run's end now waits up to 30 s for its cost and path, not 2 s: with eight runs ending at once, some ends were written without them. An end that still gets neither within that bound writes both as unknown (null) and never keeps what an earlier end stored. The series leaves out a run that learns but has no path on its record, and counts it in the new `unknown_path_runs` field. The console says "N runs' path and cost are not known: left out."
