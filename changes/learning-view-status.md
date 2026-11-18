---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: breaking
---
`GET /v2/agents/{id}/learning` says of each workflow whether it serves: `workflows[].status` is `serving`, `checking`, `held` or `stopped` (the state `GET .../learning/promotions` gives it, from the same records; one with no promotion record yet reads `checking`), else `pending` or `retired` as its README.md says. `active` is gone: a reader that tested `status === "active"` for a workflow given to runs tests that it is neither `pending` nor `retired`.
