---
packages: @parcha/agentrun-serve
kind: feature
---
A run, and its row in `GET /v2/runs` and `GET /v2/agents/{id}/runs`, carries `pending`: what it waits on, as one field told apart by `kind`, or null. A run waiting on a person carries `{kind: "question", question, asked_at}`. It is read from the run's own last row, the one its status reads, never from a scan of its timeline, so a list shows what each run waits on without a request per run, and the MCP tool `runs_get` returns it as the route does: a run with any number of timeline rows reports its current question. The served OpenAPI document gives `pending` as a union on `kind` (`pending/1`), so a later kind, a tool call waiting on approval, is one more variant of it.
