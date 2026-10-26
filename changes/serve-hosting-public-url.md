---
packages: @parcha/agentrun-serve
kind: feature
---
`AGENTRUN_PUBLIC_URL` sets the address the printed `Open` link and `AGENTRUN_BASE_URL` name, so a container published on another port, or behind a proxy, prints a link that works; a value that is not an http(s) URL stops the server at start. The compose example's `AGENTRUN_PORT` publishes another port and sets that URL. `render.yaml` and the compose example take `OPENROUTER_API_KEY` (pi-ai's OpenRouter provider, `AGENT_MODEL=openrouter/<model>`) and a gateway's `AGENT_MODEL_BASE_URL` and `AGENT_MODEL_API_KEY`. The root README opens with AgentRun as an open platform to manage your agents (the platform, AgentRun Server and the building blocks), then the two ways to host it: `docker run` with the public image, or Render's Starter with a disk.
