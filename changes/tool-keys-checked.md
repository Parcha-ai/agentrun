---
packages: @parcha/agentrun-serve
kind: feature
---
A key saved through `PUT /v2/settings/tool-keys/{id}` is checked against its provider before it is kept, with one call that costs nothing and a 5 s deadline: monid's discover, Parallel's list of monitors, Browserbase's list of projects, TypeSafe's list of models. A key the provider refuses (401) is `422 input_invalid` (reason `refused_by_provider`), in plain words with the provider's first sentence and never any of the key, and is not kept. Otherwise it is kept, and `GET /v2/settings/tool-keys` gives the row of each key stored here a `check`: `{state: "accepted", at}`, or `{state: "not_checked", reason, at}` when the provider would not answer the check (403: a key scoped away from that call may still work for its tools), did not answer in time, could not be reached, answered something else, or has no free call. A key saved before this change reads `not_checked` until it is saved again.
