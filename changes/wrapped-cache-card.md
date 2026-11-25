---
packages: @parcha/agentrun-serve, @parcha/agentrun-import, @parcha/agentrun-client
kind: feature
---
Wrapped has a cache section, and the console draws its cache grade card. The import now analyzes each Claude Code, Codex and pi session's cache as it imports it, the same way `agentrun-import --cache` does, and keeps the numbers on the run: the cache read and whole prompt behind its hit rate, its breaks by cause, what they cost above a cache read, and how many have no known price. `GET /v2/wrapped` answers `cache` by adding up the year's runs from the store, so it reads no session file again.
- `cache` is null when no run of the year was analyzed. Only runs imported here count: a session left out of the import, or imported before this version, is not in it.
- The card shows a grade from the hit rate (A+ from 97%, then a step every three points down to D from 60%, F under that), the hit rate, what breaks cost, how many there were, and breaks by cause. The cost is "Unknown" when no break could be priced, and the foot line counts the breaks left out of it.
- `@parcha/agentrun-import` exports `fileCache` and `sessionBreaks`, the per-file analysis and the join `cacheHome` uses, so another reader of a session's files gets the same breaks.
