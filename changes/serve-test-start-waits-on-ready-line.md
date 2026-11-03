---
packages: @parcha/agentrun-serve
kind: ci
---
serve's tests that start a server in a process of their own wait for the line it prints once it listens, or for its exit, never for a fixed time. The launcher tests in `secret-custody.test.mjs` and `tool-keys.test.mjs`, and the start waits in `run-metrics`, `harness-run`, `launch-loss`, `operability`, `decision-key` and `server-lock`, each polled their child's output against a clock of 10 to 120 s, so a start slowed by a loaded machine failed them as "the server did not start" though it was starting. They now share one wait in `support.mjs` that resolves on that whole line and fails at once, with what the child printed, when it exits or cannot be spawned. A 120 s backstop is left only for a child that neither prints the line nor exits.
