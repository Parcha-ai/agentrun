---
packages: @parcha/agentrun-serve
kind: feature
---
serve no longer imports `@parcha/pi-durable-disk`. The file confinement its reads and writes go through, and the rule that names a secret's variable, are now serve's own. The per-run journal barriers it called are gone: nothing had set up the per-run store they synced since the old run engine went, so on the runner they did nothing. On the runner, a paid call's hold is still flushed by the run's ledger before the call is sent. Nothing an operator or an API client does changes.
