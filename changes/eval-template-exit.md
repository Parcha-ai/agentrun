---
packages: @parcha/agentrun-serve
kind: fix
---
`agentrun-serve eval-template` no longer hangs at exit after it has printed its result or refusal (about 1 run in 160 on Node 24). The command now lets Node exit normally instead of calling `process.exit`, which could stop the V8 worker threads while a background compile was waiting for a garbage collection that only the main thread runs.
