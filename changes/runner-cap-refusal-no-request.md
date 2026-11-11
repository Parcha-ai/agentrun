---
packages: @parcha/agentrun-serve
kind: fix
---
A request a run's spend cap refused before sending is no model request on the runner, as it was before the cutover:
- A pi run whose first request the cap refused shows "no model request sent" in its usage, not "Cost so far: $0 over 1 model request", and no "Model request failed" row. The model proxy's refusal comes back through pi-ai's Messages client as `<api> API error (400): <body>`, and the timeline now reads that form as well as the bare `400 <body>`.
- A claude-agent or codex run whose cap refused its first request shows "no model request sent" in its usage too. Before, it had no usage row.
- Upgrading: nothing to change.
