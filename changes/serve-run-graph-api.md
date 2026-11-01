---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent, @parcha/agentrun-dsl
kind: feature
---
**A workflow run on AgentRun Server is drawn live, pauses and resumes, and a workflow is checked before it is saved**
- `GET /v2/runs/{id}/graph`: the run's workflow and graph, each node's state (map items labelled from the run's input, with the branch each route took for them; a route's branch), the decisions with their receipts (state seen, images, evidence, cost basis, error), the calls with their input and output, and totals. While the run goes it reads a live view the run's process writes (`live.json`), so a poll never waits on the run's store or answers `home_busy`.
- `POST /v2/runs/{id}/pause` and `/resume`: what is in flight finishes, and nothing new starts until the resume; a paused run stays paused across a restart. Run status gains `paused` (marked `pause/1`), `GET /runs?status=paused` lists them, and `GET /stats` counts a paused run as active.
- `POST /v2/workflows/validate { workflow, tools? }` answers `{ ok, issues: [{ path, code, message }], warnings }` and writes nothing. A refused save's `422` lists every issue as a field (`definition.workflow/<path>`) with its `code`.
- A workflow run's title is its agent's name and a few words of its input, never its JSON. A run's `llm` calls count in its cost.
- pi-durable-agent: `workflowIssues(workflow, tools?)` lists every issue a save would refuse; `checkWorkflowBody`'s refusal carries them, each with its message.
- dsl: the recovery driver's `pinJson()` gives its frame as it stands, for a host's live view.
