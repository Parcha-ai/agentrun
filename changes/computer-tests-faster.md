---
packages: @parcha/agentrun-computer
kind: ci
---
The computer package's slowest tests wait less: the exec pre-check's tests share one good run and stop waiting out bounds their assertions never read, and the Cloudflare provider takes a `pause` option (for tests, as Daytona's does) so its retry tests run without real backoff.
