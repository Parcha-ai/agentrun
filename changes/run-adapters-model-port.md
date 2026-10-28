---
packages: @parcha/agentrun-adapters
kind: feature
---
`modelPortFor(writer, options)`: the runner's booking of paid model requests, on its own, for a host that drives an adapter session directly (a chat run, not a DSL node). It writes the same records the runner does, `runner.request` before a request leaves and `runner.turn` with its cost when it answers, applies the same turn limit and the host's `beforeRequest`, and reports `request_start` and `request_end`. `createHarnessRunner` is built on it.
- A paid request a crash cut off (its `runner.request` with no `runner.turn`) is booked once when the session is next opened (`bookCut()`): a `runner.turn` marked `cut`, at an unknown price, and a `request_end` whose usage says `cut: true`, `usd: null`, `estimated: true`, so a host's ledger shows the possible spend. It is booked once however many times the session is recovered.
