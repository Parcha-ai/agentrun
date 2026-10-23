---
packages: @parcha/pi-durable-agent
kind: fix
---
A vault error about a malformed origin names only the fault. `sessionVault`'s `capture`, `restore` and a provider context's `origins` refused an origin that is not an http(s) origin with a message that carried the origin itself, and a `localStorage` keyed by a bad origin did the same; both messages are now fixed strings, and the value is nowhere in the error.
