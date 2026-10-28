---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: feature
---
**A definition names its harness: pi, claude-agent or codex**
- `definition.harness` is `pi` (the default, and what a definition that names none gets), `claude-agent` or `codex`; any other is `422 input_invalid` on the field. Every answer names it. An edit that names no harness keeps the agent's (as it keeps its skill files), and the page sends back the harness it read. The default is never stored, so a revision written before this field and one that names pi are the same revision.
- `GET /v2/capabilities` lists `harnesses`: each with `available` and, when not, its `reason`. A definition naming a harness this server does not run yet saves with a warning on `definition.harness`, and its runs are `409 agent_not_runnable` with `details.harness`, never run on pi instead. This server runs pi today.
- `GET /v2/openapi.json` marks every property this server adds to the contract's objects `x-agentrun-serve` with the addition that made it (`harness/1`, and `model/1` and `serve/1` for what it added before), and lists them in `info.x-agentrun-serve.fields`. Without them, the contract is as vendored.
- The agent store (`@parcha/pi-durable-agent`) keeps an optional `harness` id in a revision's body, so in its id.
