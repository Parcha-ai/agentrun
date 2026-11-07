---
packages: @parcha/agentrun-serve, @parcha/pi-browser, @parcha/agentrun-harness, @parcha/agentrun-pi, @parcha/pi-durable-disk
kind: fix
---
Packages take TypeBox's `Type`, `Static` and `TSchema` from typebox, never through pi-ai, pi-agent-core, pi-durable or chord, which drop those re-exports from pi 1.5. serve, pi-browser and pi-agent-learn now depend on typebox 1.3.27 directly (the version pi-ai 1.1 resolves); harness and agentrun-pi keep it as a host-provided peer. Tool schemas serialize exactly as before, so tool arguments are checked the same. harness's `shownShots` has a named return type, `ShownShots`.
