---
packages: @parcha/agentrun-serve
kind: ci
---
Two launcher tests in `secret-custody.test.mjs` read what the launcher said once its process ends on `close`, not `exit`. `exit` can come before the child's stderr pipe is read to its end, so the refusal of secrets past a pipe's 4096 bytes could read as an empty string and fail the test intermittently.
