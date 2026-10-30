---
packages: @parcha/agentrun-claude-agent, @parcha/agentrun-adapters
kind: feature
---
A host's gateway headers reach the provider on every model request a Claude Agent session makes: `claudeAgentAdapter({ provider: { ..., headers: { "x-litellm-tags": "job:...,purpose:...,run:..." } } })`, the same LiteLLM spend-tag header a pi lead's model requests carry, so a gateway attributes the Claude lead's spend to its job. The session's model proxy (`startModelProxy({ headers })` in `@parcha/agentrun-adapters/host`) adds them to every forwarded request, paid and free, after the client's own headers (so the CLI can neither set nor override them) and before the credential's. They are checked when the adapter is made (`hostHeaderProblems`): a token name that is not the proxy's own (`authorization`, `x-api-key`, `host`, `content-*`, `anthropic-*`, ...), and a one-line value of at most 1024 characters. A host sends a gateway's headers only to that gateway.
