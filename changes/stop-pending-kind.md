---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: fix
---
A run whose turn a person stopped now says so to an API reader: `GET /v2/runs/{run_id}` and its item in `GET /v2/runs` carry `pending: {kind: "stopped"}` beside status `input_required` and state `idle`, so a stopped run no longer reads like one that is stuck. The `run.needs_input` webhook tells that stop with the same kind, once, across a restart too.
- A person's stop used to reach the webhook as `run.ended` with status `input_required`. It is a wait the run stands at, so it is now `run.needs_input`; `run.ended` comes when the run ends.
- A turn its harness ended on its own reads the same status and state with `pending` null, and its `run.needs_input` carries no `pending`. It was told as `stopped` before. The webhook's kind is always the run read's `pending.kind`, `computer` included.
- `agentrun runs wait` says a stopped run was stopped, and says of a run whose turn ended on its own that it ended its turn.
- Breaking: a reader that took `pending` null with input_required and idle as stopped reads `pending.kind` `stopped`; a webhook receiver that took `run.ended` with status input_required as a stop gets `run.needs_input` with `pending.kind` `stopped`. The generated TypeScript and Python clients gain the kind.
