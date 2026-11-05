---
packages: @parcha/agentrun-serve
kind: fix
---
A workflow run's graph (`GET /v2/runs/{id}/graph`) shows its nodes, decisions and calls (each call's input, output and error) with no held secret in them, by the same rule as the run's answer: a key the server holds or handed the run reads `[redacted]`. Each part is redacted once per content and held key set, so polling a running workflow's graph does not redact it again on every read. A key saved after a read is redacted from the next one.
