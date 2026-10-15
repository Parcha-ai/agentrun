---
packages: repo
kind: ci
---
The stranger job's `registry` mode, which installs `@parcha/pi-durable-disk@beta` with the README's own install line against
the registry's latest peers and runs the README's quickstart, is blocking: 0.1.0-beta.13 installs beside pi-durable,
chord and pi-ai 1.2.0 with no ERESOLVE, where 0.1.0-beta.12 could not.
