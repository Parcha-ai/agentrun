---
packages: @parcha/agentrun
kind: breaking
---
The setup skill's Local model step says to start Ollama: the server lists its models itself, so the service gets no gateway and no key for it. The first-run walks run on a fake Ollama. On a server with a public address (`--tailscale`, `--public-url`), the skill and the launcher's README say to set `OLLAMA_HOST`, the default address too: only one person's own server asks it unset.
- Breaking: `agentrun service install --env AGENT_MODEL_API_KEY=none` is refused, and a re-install drops it from a service that has it. A service that reached Ollama through `AGENT_MODEL_BASE_URL` then gets `model_key_required`. Remove the gateway with `agentrun service install --env AGENT_MODEL_BASE_URL= --env AGENT_MODEL_GATEWAY_IDS= --env AGENT_MODEL= --env AGENT_MODEL_PRICE=`, start Ollama, and pick the model as `ollama/<tag>`.
