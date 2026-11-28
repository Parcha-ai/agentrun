---
packages: @parcha/agentrun-harness-codex, @parcha/agentrun-serve
kind: fix
---
Codex on a model on the host's own machine (an Ollama model) waits out a silent stream for 30 minutes, as claude-agent's CLI already does. A slow machine that took more than five minutes to load the model or read a long prompt used to end the turn with "stream disconnected before completion: idle timeout waiting for SSE". The Codex adapter takes `streamIdleMs` (Codex's `stream_idle_timeout_ms` on its provider) and exports `LOCAL_STREAM_IDLE_MS`; serve sets it for an Ollama model, in process and on a runner. Any other route keeps Codex's own five minutes.
