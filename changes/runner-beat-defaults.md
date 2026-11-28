---
packages: @parcha/agentrun-serve
kind: ci
---
The runner's default poll, resume backoff and interrupt backoff are named constants, `RUNNER_POLL_MS` (1 s), `RESUME_BACKOFF_MS` (5 s) and `INTERRUPT_BACKOFF_MS` (1 s), which `startRunner` defaults to as before. The tests that count the runner's beats read them, so their tenth-scale timing moves with a changed default instead of drifting from it. Nothing a runner does changes.
