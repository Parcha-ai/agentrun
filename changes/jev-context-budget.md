---
packages: @parcha/agentrun-jev
kind: fix
---
The Jev runner never sends a request over Jev's context (32k tokens for the state plus any one question, 64k for all of them; `JEV_CONTEXT_TOKENS`), which Jev refused whole with HTTP 400 `max_tokens_exceeded` and failed the workflow step. Measured by its UTF-8 bytes, which bound its tokens, a request that may not fit goes whole with TypeSafe's `TypeSafe-Danger-Zone-Long-Context` header (262k tokens, same price; `longContext`, on by default on TypeSafe's route); one that may not fit that either, or the default on OpenRouter, has its longest state values cut, each ending ` [cut]` (`JEV_CUT_MARK`). Questions too long even then are refused before sending (`over_context`).
Behaviour change: a judge request over the default context now runs in Jev's slower long-context mode instead of failing; pass `longContext: false` to cut to the default context instead.
