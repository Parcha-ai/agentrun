---
packages: @parcha/agentrun-serve, @parcha/agentrun
kind: fix
---
Saving or removing a key no longer waits on a stuck Ollama. Once the kept Ollama listing was more than 30 s old, each save asked Ollama about every model it lists, one at a time, up to 10 s each, before it answered. The offers and the model check a save makes again now read each Ollama model from the kept listing, and ask Ollama nothing. A run still asks Ollama about its own model once the listing is 30 s old.
- `agentrun service install` now takes `--env OLLAMA_CONTEXT_LENGTH=<tokens>`, so a service can run on a context lower than 65,536. `OLLAMA_CONTEXT_LENGTH=` with nothing after it removes it.
