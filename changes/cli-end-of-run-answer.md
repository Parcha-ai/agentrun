---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-claude
kind: fix
---
A CLI run's end-of-run turn (its learning step) now reads the turn's last message as its answer, as a pi run's always has. Before, it ran every message of the turn together, so a claude-agent turn whose stream stalled and was asked again whole stored the stalled part and the whole answer as one. The Claude adapter takes the stream idle limit from its host (`streamIdleMs`, `LOCAL_STREAM_IDLE_MS`) rather than from a route's `fetch`, and serve sets it only for a model on its own machine.
