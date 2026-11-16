---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-decisions
kind: feature
---
Model requests AgentRun sends to OpenRouter carry OpenRouter's app attribution headers: `HTTP-Referer: https://github.com/Parcha-ai/agentrun`, `X-OpenRouter-Title: AgentRun` and `X-OpenRouter-Categories: cloud-agent,personal-agent`. Usage then counts toward AgentRun's page on OpenRouter (openrouter.ai/apps?url=https://github.com/Parcha-ai/agentrun), including a self-hosted server's usage on its owner's own key. Set `AGENTRUN_OPENROUTER_ATTRIBUTION=off` where AgentRun starts to send none.
- The headers go only where a request goes to openrouter.ai itself, which covers every harness: the model proxy (claude-agent, codex, opencode, and pi on OpenRouter's Anthropic and OpenAI models), pi's translation route (every other OpenRouter model, the free ones included), and the server's Decisions providers on OpenRouter (OpenRouter's models, and Parallel's through OpenRouter). Anthropic, OpenAI, a ChatGPT plan and a gateway at another URL never get them.
- The kernel's host entry (`OPENROUTER_APP`, `openRouterApp`, `openRouterAttribution`) is the one place that names the app; the server hands it to the Decisions provider.
- The Decisions provider's `app` option takes `categories` and sends `title` as `X-OpenRouter-Title` (OpenRouter's current name for `X-Title`).
