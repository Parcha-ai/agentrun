---
packages: @parcha/agentrun-serve
kind: feature
---
OpenRouter's key alone now runs every harness. With `OPENROUTER_API_KEY` set and none of a harness's own settings, claude-agent uses OpenRouter's Messages endpoint and codex its Responses API, both at `https://openrouter.ai/api` with the key as a bearer token. The OpenRouter model key's defaults are `openrouter/openai/gpt-6-sol` for pi, `anthropic/claude-sonnet-5.5` for claude-agent and `openai/gpt-6-sol` for codex. Anthropic's and OpenAI's keys still give the default first where they are set. A harness's own settings still win: the endpoint the host names (`ANTHROPIC_BASE_URL`, `AGENT_MODEL_BASE_URL`), then the vendor's key. An endpoint the host names never gets the OpenRouter key.
- claude-agent sends Anthropic's own model id (`claude-sonnet-5-5`) to OpenRouter, as it does direct, and its run is priced by OpenRouter's catalog entry. `claudeProvider` returns `{ origin, credential, auth, modelId, priceModel }` (the `ClaudeProvider` type), so anything else that calls the run's model reads the same answer.
- A model named `openrouter/<vendor>/<model>` (pi's name for it) runs on claude-agent and codex too. claude-agent used to refuse it as more than one segment.
- pi now takes serve's gateway at `<base>/v1/responses`, after one trailing `/v1` is taken off the base, as codex and claude-agent do. `AGENT_MODEL_BASE_URL=https://openrouter.ai/api` used to send pi to `/api/responses`, a 404 at OpenRouter.
- With no model here, the words name `OPENROUTER_API_KEY` first, and claude-agent's name it too.
- A provider's 401 now fails the run with the key by name and where to set it, on every harness: "OpenRouter refused OPENROUTER_API_KEY (401: User not found): set it where AgentRun starts, or save it in Settings → Model keys." Only the provider's first sentence is kept, and never the key. Anthropic's and OpenAI's keys, and serve's gateway key (`AGENT_MODEL_API_KEY`), read the same way.
