---
packages: @parcha/agentrun-serve
kind: fix
---
A run the runner takes on a model gateway (`AGENT_MODEL_BASE_URL`) now sends the gateway the model id the run's start chose, the one the server sends for the same agent, priced by the provider the agent's model names. Before, the runner joined the gateway's provider name and that id (`agent-model/gpt-6-luna`), which the gateway refused with 400 "Invalid model name", so every pi and CLI run on a gateway failed unless its ids were bare; with bare ids a model the catalog prices per provider was priced as another provider's.
