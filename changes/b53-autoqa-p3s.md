---
packages: @parcha/agentrun-serve
kind: fix
---
Two findings from the beta.53 QA pass.
- `GET /capabilities` no longer serves pi as `available: true` on a server with no model key and no ChatGPT sign-in. A harness none of whose models runs here until a key or the sign-in is added is `available: false`, as codex already is. One whose default model lacks a key while another of its models runs stays available, and its `needs` says what the default lacks. The console's agent page says the missing key once, and still shows a model blocker in other words. The agent editor keeps such a harness a choice, its card saying "Needs a model key", since a save of it is taken with a warning; one off for another reason stays greyed out. The published-server check in `docs/releasing.md` now expects pi to say it needs a model key.
- `features.sdk_runs.max_open_s` says what it bounds: a run that keeps sending batches. An SDK run that gets no batch closes an hour after its start.
