---
packages: @parcha/agentrun-serve
kind: fix
---
`POST /v2/agents` and `PUT /v2/agents/{id}/definition` now check a definition for what keeps it from running here, with the checks a run makes before it starts. A definition that can never run here is `422 input_invalid` by field and nothing is saved: a tool this host does not bind (`definition.tools[i]`, `bash` among them), a model pi-ai does not know (`definition.model`), empty instructions (`definition.instructions`), or a workflow that needs a tool call, a judge, code or a node tool other than `read`, `write` and `edit` (`definition.workflow`). Before, these saved (`201`/`200`) and every run was `409`. A definition this host cannot run yet but could (no key for the model's provider, no default model, no model for a workflow tier) still saves, and the answer lists what is missing in `warnings`; the page shows them. Runs of such a revision, or of one saved before these checks, are still `409 agent_not_runnable`.
