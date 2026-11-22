---
packages: @parcha/agentrun-serve
kind: fix
---
The dial conformance script accepts `AGENTRUN_BIND_HOST` so local verification can bind to `127.0.0.1` without exposing a public listener. Its local fixture tests use this setting; leaving it unset preserves the public listener used by remote machines.
