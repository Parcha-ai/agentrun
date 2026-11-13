---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client
kind: feature
---
An agent's Learning tab replays how its learned workflow changed: the workflow it runs now is drawn as the console's workflow graph, with a step for each revision that changed it. A step shows the graph as it was then with each node marked NEW (first in that revision) or EDITED (its prompt, code, inputs or tier changed), one line saying what changed, and the revision's date and author. Play steps through them; the slider and the arrows go to any one.
`GET /v2/agents/{id}/learning/workflows/{name}/revisions` (`learning/1`) answers the latest revisions (`?limit=`, at most 50), oldest first, each with who made it, when, why and the workflow.json text it had then; `agentrun learning workflow-revisions <agent> <name>` prints them.
