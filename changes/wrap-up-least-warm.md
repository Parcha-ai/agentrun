---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A capped run on a CLI harness (Codex, Claude Code) prices its next request from the cache its previous request left warm, at admission, for the wrap-up note and for the room it keeps back to answer, so it is no longer told to finish, or refused a tool call, while what is left still buys many of its steps.
- Before, a CLI's request names its model as its provider does (`openai/gpt-6.1-sol`, `claude-sonnet-5-5`) while the cap prices it under the run's model id (`gpt-6.1-sol`, `anthropic/claude-sonnet-5.5`). The session's previous request was filed under the first and looked up under the second, so every request was priced as if nothing were cached. The note and the reserve never read the previous request at all, on any harness.
- Example: a Codex run under $0.50 was told to finish with $0.45 left, because its next request was priced at $0.23 all fresh; read from the cache, it needed about $0.05.
- Admission's rule is unchanged: a request whose least does not fit what is left is refused. A request with no previous one in hand (a run's first, or one after a compaction) is priced uncached, as before. A CLI request on a warm cache is now held at its warm price, as pi's already was.
- Kernel: `capRequestOf` builds a request as the cap prices it (its model, and the session's previous request when it continues the conversation, looked up by the priced model's id). `RunCap.asked(request)` returns it with the run's own pricing. `beforeRequestOf` uses the same function.
