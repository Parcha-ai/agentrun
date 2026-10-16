---
packages: @parcha/agentrun-jev
kind: feature
---
`createJevRunner` can reach Jev through OpenRouter: `provider: "openrouter"` (default `"typesafe"`, unchanged) sends to OpenRouter's System One path (`https://openrouter.ai/api/v1/systemone`, or an explicit `baseURL`) with `~typesafe/jev-latest` as the default model, and takes its key from `apiKey` or `OPENROUTER_API_KEY`; it never falls back to `TYPESAFE_API_KEY`. `jevProviderFromEnv(env)` returns `"openrouter"` only when `OPENROUTER_API_KEY` is set and `TYPESAFE_API_KEY` is not. The caps (`timeoutMs`, `maxStateBytes`, retries) are unchanged. `cost_usd` is the provider's `usage.cost` when reported, else the configured `pricing` estimate, else `null`, never 0, and a `usage` with a cost and no token counts is now accepted (it returns `usage: null`). `provider` cannot be combined with `client`. New public API; no stored format changes.
