---
packages: @parcha/agentrun-serve
kind: fix
---
A slow or failed Ollama listing no longer hides Ollama's models for 30 seconds. A listing that missed its 2-second deadline (while Ollama loaded a model, say) or got a wrong-shaped answer was kept as "no models", so codex, opencode, claude-agent and pi had no default and a run naming no model was told to start Ollama while it was running. Now a failed listing keeps the models listed before it and is asked again at once.
