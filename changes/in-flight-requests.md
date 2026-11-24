---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: feature
---
A live run shows what it waits on while it waits, not only once it answers (GRE-4835): a model request from the moment it is sent, on every harness, and each tool call until it returns. A slow local model reading a long prompt shows "inkling-2-mini thinking · 2:13" under the run's header, ticking; a slow `web_fetch` shows "web_fetch · 0:41".
- The kernel stamps each model request's record (`runner.request`) with when it left (`at`) and the input it was admitted with (`inputTokensMax`), written before the request leaves, as the record already was. `ModelPortOptions.now` sets the clock.
- `GET /v2/runs/{id}/timeline` pages carry `in_flight` (`inflight/1`, this server's own beside the vendored contract): each model request with no answer yet (its model, `started_at`, `input_tokens_max`, and `for_tool` for a tool's own request) and each tool call with no result yet (its tool, `started_at`, `tool_use_id`), oldest first; empty once the run is final. A request sent or answered is a change of the page, so a long poll or the event stream wakes for it.
- Not yet: tokens counted while a model streams its answer; the Dev tools trace still lists a model request once it answers.
