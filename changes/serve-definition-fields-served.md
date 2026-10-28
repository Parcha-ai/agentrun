---
packages: @parcha/agentrun-serve
kind: fix
---
`GET /v2/openapi.json` now says which definition fields serve takes, and what a run it refuses holds. `DefinitionInput` showed the contract's `input_schema`, `output_schema` and `max_cost_usd` as fields, though serve refuses each with `422 not_allowed`. Each is now marked `x-agentrun-serve-unsupported` with the reason its 422 gives, and listed in `info.x-agentrun-serve.unsupported_fields`. `ErrorBody.details` gains `x-agentrun-serve-details`: the shape of `agent_not_runnable`'s details here (`unbound`, `missing`, `harness`, and for a workflow `adapters`, `code`, `tier`). `harness`, `model` and `thinking` were served already, as `x-agentrun-serve` additions.
