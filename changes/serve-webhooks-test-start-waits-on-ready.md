---
packages: @parcha/agentrun-serve
kind: ci
---
The webhook test whose server dies under a waiting run starts that server in a process of its own, and now waits for it with the shared `printed` wait in `support.mjs`: it resolves on the server's whole `AGENTRUN_API_KEY=` line and fails at once, with what the child printed, if it exits. Before, it polled the child's output against a 20 s clock, so a start slowed by a loaded machine failed the test as "waited for the server's banner" though the server was still starting.
