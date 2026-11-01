---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: feature
---
An agent definition can name its place: `{mode: "runner"}`, `{mode: "tool-box", box}` with `bwrap`, `docker`, `modal` or `daytona`, or `{mode: "sandbox", box}` with `docker`, `modal` or `daytona`; any other shape is `422 input_invalid` on `definition.place`. The revision keeps the place it names, an explicit runner included, and a definition that names none keeps none, so existing revisions keep their ids and answers show no place for them. An edit that names no place keeps the agent's. `GET /v2/capabilities` lists `places` (the modes, the default `runner`, and each box with whether this server has it); no box is set up on any server yet, so a tool-box or sandbox place saves with a warning and its runs are `409 agent_not_runnable` with `details.box`.
