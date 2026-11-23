---
packages: @parcha/agentrun-serve
kind: fix
---
Saving a workflow agent whose workflow is invalid (`POST /agents`, `PUT /agents/{id}/definition`) is `422 input_invalid` again, with each issue `POST /workflows/validate` lists as a field at its path under `definition.workflow` (for example `definition.workflow/root/steps/0`, code `NODE_FIELD_INVALID`), and nothing is saved; since runs moved to the runner, such a workflow was saved and failed only when it ran.
