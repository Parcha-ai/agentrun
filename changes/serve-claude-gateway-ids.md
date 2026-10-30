---
packages: @parcha/agentrun-serve
kind: fix
---
claude-agent runs on OpenRouter's own model ids. When `ANTHROPIC_BASE_URL` is the same gateway as `AGENT_MODEL_BASE_URL` (one gateway for every harness, as with one OpenRouter key), claude-agent now sends the revision's `anthropic/<model-id>` whole, as the other harnesses send theirs, instead of Anthropic's bare id, which such a gateway does not know. A revision names `anthropic/claude-sonnet-5.5`, as for Anthropic itself; the doubled `anthropic/anthropic/...` it needed before no longer runs. `AGENT_MODEL_GATEWAY_IDS=bare` sends Anthropic's id, and an `ANTHROPIC_BASE_URL` of its own (an Anthropic-compatible endpoint) still gets Anthropic's id. The run is priced as Anthropic's model, so its cost is an estimate rather than unknown.
