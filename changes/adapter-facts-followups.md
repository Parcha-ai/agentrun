---
packages: @parcha/agentrun-serve
kind: fix
---
pi refuses an `AGENT_MODEL_BASE_URL` its key may not go to before a run starts, as codex and opencode do: capabilities read the model not ready, a save warns, and a run is refused in the one base rule's words, so the gateway key is never handed to a run's process. The base rule also finds a `.` or `..` path segment however the slashes after the scheme are written (`https:/gw.example//../x`). `AGENTRUN_HARNESS_TABLE` loads its module only under a test runner (`NODE_TEST_CONTEXT`); anywhere else it is ignored.
