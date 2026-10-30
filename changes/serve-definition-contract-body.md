---
packages: @parcha/agentrun-serve
kind: fix
---
`PUT /v2/agents/{agent_id}/definition` takes the contract's body: the definition itself, as hosted takes it, with the contract's preconditions. `If-Match` is required (`412 precondition_failed` without it), and `definition.version` must be greater than the current one (`422` on `definition.version`). A client written to the contract can now edit an agent here. This server's own body, `{definition, skills?, note?}` like `POST /agents`, still works with `If-Match` optional, and the served document now describes both bodies as exactly one of the two, marked `definition-body/1`, plus the `note` that `POST /agents` takes.
