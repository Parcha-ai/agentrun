---
packages: @parcha/agentrun-serve, repo
kind: feature
---
`GET /v2/capabilities` names each harness's default model: `harnesses[].default_model`, the model this server runs for that harness when a definition names none (`provider/model-id`), or null where it runs none (the harness does not run here, or no default model here runs on it; claude-agent never takes a gateway's model). It is the model a save and a run resolve, through one function (`harnessModel`, which `blockersOf` now calls too), so capabilities and saves cannot disagree. The console reads it: the editor's Model field and the agent page offer each harness the default the server names for it, so a codex agent behind a gateway is offered the gateway's default, and a claude-agent agent is told to choose a model. A server that does not name them keeps the console's earlier rule, pi alone.
