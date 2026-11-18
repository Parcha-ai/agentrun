---
packages: @parcha/agentrun-harness-acp, @parcha/agentrun-kernel
kind: feature
---
Goose 1.59.2 runs as an AgentRun harness on the ACP adapter: `gooseAdapter({ binary, model, provider, price })` checks the binary's sha256 against its pin, starts `goose acp` from the shipped recipe (`recipes/goose.json`, loaded by `recipeFile` and `gooseRecipe`), and points each Goose process at a model proxy of its own (`gooseProxy`) on the session's booking, so the run's cap and books hold as they do for Claude Code.
- The recipe turns every bundled Goose extension off, blocks Goose's model catalog download with a dead egress proxy, mirrors its sessions so another runner's Goose loads them, and leaves the model our MCP tools (`agentrun__<name>`) and Goose's `load_skill`.
- Goose's proxy forwards only `POST /v1/messages`, with the API's version and the one `anthropic-beta` value the pinned Goose sends (`GOOSE_BETAS`), never Goose's `agent-session-id`. It answers `GET /v1/models` itself with the run's model, and refuses any other model, tool, hosted tool or beta before the provider is asked.
- `GOOSE_PIN` records the release as the ACP registry listed it, with where and when it was read. `verifyPinnedBinary` refuses a binary whose sha256 differs (`ACP_BINARY_MISMATCH`), reading it and never running it. `gooseAdapter` checks it when the adapter is made and again before every Goose process starts (the adapter's new `beforeStart` option), so a binary replaced in between never runs unchecked. `verifyFirstSeen` records the first verified digest of an agent the registry lists without one, and refuses later drift (`ACP_BINARY_DRIFT`).
- The adapter's `proxy` option is now called with the session's booking, its tools' names and a halt of its drive (`AcpProxySession`).
- The kernel's model proxy can answer a local route with a fixed JSON body (`ProxyRoute.localJson`), only to the session's key or a side key.
