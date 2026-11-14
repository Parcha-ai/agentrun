---
packages: @parcha/agentrun-serve, @parcha/agentrun-client
kind: feature
---
An agentic agent can take typed run input: `definition.input_schema`, a JSON Schema object, and every run's `input` is checked against it with the full compiler before the run starts.
- Every path that starts a run checks it the same way: `POST /v2/agents/{id}/runs`, the CLI, the clients, the MCP `runs_start` tool, a trigger (when it is saved and when it fires), a template's trigger at apply, and the console. An input the schema refuses is `422 input_invalid`, one issue per field, by path (`input.country`, `input.topics.1`) and reason (`missing`, `wrong_type`, `not_allowed`, `not_an_option`, `bad_format`, `too_short`, `too_long`, `too_few`, `too_many`, `duplicate`, `invalid`).
- `content` is always a string. It is required when the schema requires nothing else. An edit that leaves `input_schema` out keeps it. A workflow agent refuses it (its workflow's own input schema is the one in force).
- The model is sent the input's `content`, then the other fields as one fenced `json` block under the line `Input:`, on pi, claude-agent and codex alike. A value holding backticks gets a longer fence, so no value ends the block.
- Templates: a package's `inputs:` (the parameter vocabulary plus `title`, `examples`, bounds and lists of a scalar) compile into the agent's `input_schema`, shown on `GET /v2/templates` as `input_schema`. A template's trigger input and each eval case's `input:` front matter are checked against it.
- The `kyb` template takes its subject as typed input (`company`, and optionally `website`, `country`, `registration_number`, `reason`), matching its report's `subject.input`. An agent applied from it before keeps its own definition. A newly applied one refuses a run without `company`.
- Console: an agent with an `input_schema` gets a run form drawn from it, with the same field renderer as the template parameter form, and its issues shown on the fields.
