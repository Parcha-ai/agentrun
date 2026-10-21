---
packages: repo
kind: docs
---
`examples/moves/env-probe.ts`: an offline environment probe for the moves take. It looks, by SHA-256 over every window of each secret's length, for the take's secret values in its own environment and in every `/proc/*/environ` and `/proc/*/cmdline` its user can read, and reports counts, never a value. A process that started with a key and only deleted it from `process.env` is found; one handed the key on a file descriptor is not.
