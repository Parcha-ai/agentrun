---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-decisions, @parcha/agentrun-jev
kind: feature
---
Every model request AgentRun sends to OpenRouter carries OpenRouter's app attribution headers: `HTTP-Referer: https://github.com/Parcha-ai/agentrun`, `X-OpenRouter-Title: AgentRun` and `X-OpenRouter-Categories: cloud-agent,personal-agent`. Usage then counts toward AgentRun's page on OpenRouter (openrouter.ai/apps?url=https://github.com/Parcha-ai/agentrun), including a self-hosted server's usage on its owner's own key. Set `AGENTRUN_OPENROUTER_ATTRIBUTION=off` where AgentRun starts to send none.
- The headers go only where the request goes to openrouter.ai itself, covering every harness: the model proxy (claude-agent, codex, opencode, and pi on OpenRouter's Anthropic and OpenAI models), pi's translation route (every other OpenRouter model, the free ones included), and the Decisions and Jev providers. Anthropic, OpenAI, a ChatGPT plan, TypeSafe and a gateway at another URL never get them.
- `@parcha/agentrun-kernel/openrouter-app` is the one place that names the app. The Decisions provider's `app` option still names your own app in its place.
