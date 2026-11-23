---
packages: @parcha/agentrun-serve
kind: fix
---
Two findings from the beta.53 QA pass.
- `GET /capabilities` no longer serves pi as `available: true` on a server with no model key and no ChatGPT sign-in. A harness that `needs` a key or the sign-in before a run starts is `available: false`, as codex already is. The console's agent page names what it lacks once, not twice.
- `features.sdk_runs.max_open_s` says what it bounds: a run that keeps sending batches. An SDK run that gets no batch closes an hour after its start.
