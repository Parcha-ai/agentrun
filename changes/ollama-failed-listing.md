---
packages: @parcha/agentrun-serve
kind: fix
---
A slow Ollama listing no longer hides Ollama's models for 30 seconds. A listing that missed its 2-second deadline (while Ollama loaded a model, say) or got a wrong-shaped answer was kept as "no models", so codex, opencode, claude-agent and pi had no default, and a run naming no model was told to start Ollama while it ran. Now such a listing keeps the earlier models and is asked again at once. A stopped Ollama lists none.
