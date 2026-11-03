---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-claude
kind: feature
---
claude-agent and codex now run with only an OpenRouter key. With `OPENROUTER_API_KEY` set and none of a harness's own settings, claude-agent uses OpenRouter's Messages endpoint and codex its Responses API, both at `https://openrouter.ai/api` with the key as a bearer token. Each harness is available on that key alone, and its default model is `openrouter/anthropic/claude-sonnet-5.5` or `openrouter/openai/gpt-6.1-sol`. A harness's own settings still win, in this order: the endpoint the host names (`ANTHROPIC_BASE_URL`, `AGENT_MODEL_BASE_URL`), then the vendor's key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). An endpoint the host names never gets the OpenRouter key.
- A model named `openrouter/<vendor>/<model>` (pi's name for it) runs on claude-agent and codex too. claude-agent used to refuse it as more than one segment. Through OpenRouter, a model is priced by OpenRouter's catalog entry.
- The Claude CLI keeps Anthropic's own model id, which it knows the limits and betas of. `claudeAgentAdapter({ provider: { models: { "claude-sonnet-5-5": "anthropic/claude-sonnet-5.5" } } })` makes the session's model proxy send the provider's name instead. The runner is still asked about the session's model.
- `claudeProvider` and `codexProvider` now also return `auth` (`x-api-key` or `bearer`) and `modelId`, the id that endpoint takes.
