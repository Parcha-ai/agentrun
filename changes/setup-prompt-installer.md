---
packages: @parcha/agentrun
kind: feature
---
`agentrun service install --env KEY=VALUE` gives the service a local model: `AGENT_MODEL_BASE_URL`, `AGENT_MODEL_GATEWAY_IDS`, `AGENT_MODEL` and `AGENT_MODEL_PRICE`, written into the launchd or systemd unit. They stay through `service restart`, the installer and a later `service install`, and `--env KEY=` removes one. Any other name is refused before anything is written, so no key ever lands in a unit file. An `--env` on an installed service keeps its `--data` and `--port`.
- The setup prompt (`docs/SKILL.md`, served at agentrun.ai/SKILL.md) starts AgentRun on this computer with `curl -fsSL https://agentrun.ai/install | sh` in place of a Node check and `npx`, and every later step runs `~/.agentrun/bin/agentrun`. A local Ollama model is one `service install --env` line. The Railway step is the template's button, https://railway.com/deploy/agentrun, with `AGENTRUN_TOKEN` from the service's Variables tab as the setup code. The first agent's definition no longer names a place or a thinking level, and LM Studio is gone from the model step.
