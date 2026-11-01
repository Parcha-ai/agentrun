---
packages: @parcha/agentrun-serve
kind: feature
---
AgentRun Server runs Jev on the model gateway's key when that gateway is OpenRouter. With `AGENT_MODEL_BASE_URL` on the host `openrouter.ai` (exactly that host) and `AGENT_MODEL_API_KEY` set, a workflow's typed questions go to Jev through OpenRouter on `AGENT_MODEL_API_KEY`, so a server on an OpenRouter gateway needs no second key for decisions. `TYPESAFE_API_KEY` still comes first, then `OPENROUTER_API_KEY`; a gateway on any other host does not run Jev.
- On the OpenRouter route, jev's `note` in `GET /capabilities` names the variable Jev runs on: `Jev runs on OPENROUTER_API_KEY, ...` or `Jev runs on AGENT_MODEL_API_KEY, ...`. Both are the model gateway's key, which a run's processes already hold; set `TYPESAFE_API_KEY` to keep the decision key out of them.
- On either OpenRouter variable, the server hands the key to a workflow run's process on the decision descriptor, as it hands `TYPESAFE_API_KEY`. The run's judge reads its key there, never from its environment.
- With no key, jev's `reason` (and the `not_set_up_here` warning and `409` message) also names the gateway route.
