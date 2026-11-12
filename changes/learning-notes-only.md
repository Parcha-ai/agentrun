---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, repo
kind: breaking
---
An agent can learn notes and skills without learned workflows. Its definition's `learning` is now `true`, `false` or `"notes"`. `true` still learns notes, skills and learned workflows. `"notes"` learns notes and skills only: a run is given its notes and skills, never a learned workflow (no `learned_workflow` tool), and its end-of-run turn asks for no workflow draft. A draft it gives anyway is left out by the checks (rule `workflow`), and its notes and skill go on. A run's launch records `notesOnly` for such a run. The console's editor shows the two choices under "Learns from its runs": "Notes, skills and workflows" and "Notes and skills only".
Upgrading: a client that reads `definition.learning` handles the value `"notes"` beside `true` and `false`.
