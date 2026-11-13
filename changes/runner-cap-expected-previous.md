---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A capped run on the runner is priced the way the cap's `expected` mode says: each model request from the previous request of its session. The cache that request read or wrote counts at the cache-read price, and only its other input plus what the body grew by since counts at full price. Before, the runner gave the cap no previous request, so every step was held as a whole cache miss, and a run needed a cap several times what it spent (a 5-step Sonnet run that spends $0.04 needed $0.11). `strict` mode is unchanged: every token uncached. A side call (a title, a summary) is priced as a cache miss, as a host's own request already was.
