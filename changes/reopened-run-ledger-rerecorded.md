---
packages: @parcha/agentrun-serve
kind: breaking
---
A learning run that a follow-up opened again and that ended before this release has its ledger row recorded again under the new split, once, at the server's first start on this release. Its `cost.usd`, `learning_usd` and `followup_usd`, the agent's cost page and its bill read the follow-up as the job's, as `tools_usd` and the usage lines do. Before, such a run kept its job at its first round's figure, so its read could show `tools_usd` above `usd` and count the follow-up both in `learning_usd` and in its usage lines. The pass reads only the runs whose learning kept a second round, a page of 64 a transaction, and a stop partway goes on at the next start.
`GET /v2/runs/{run_id}` of a run a learned workflow served reads the agent's ledger, for its share of its revision's compile and check, outside the store snapshot that reads its `usd` and `tools_usd`. Before, that read held the snapshot over every run of the agent: on SQLite every runner's journal commit waited behind it, and on a large agent the read failed past the store's 10 s deadline.

Upgrading: the store moves to Postgres migration `0033` and SQLite version 18, and both break runners of earlier builds, whose end still writes such a row the old way: the runner floor rises to 33. Stop the earlier runners before this release's server starts, then start the runners of this release.
