---
packages: @parcha/pi-git-remote
kind: ci
---
The two tests that need a push to fail after the local commit (`an end whose push failed is retried by the next end` and `a push that failed does not make the saved state the pushed one`) make the remote refuse every pack with its own `receive.maxInputSize` instead of making its objects read-only, so they hold when the suite runs as root, as in a container.
