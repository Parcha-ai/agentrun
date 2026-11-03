---
packages: @parcha/agentrun-decisions
kind: fix
---
A request to `openrouterProvider` now waits for its image check only within its deadline and cancel. Before, the first image request to a model other than Jev waited for `takesImages` before its deadline started and without looking at the run's signal. The catalog read behind it has its own 10 s bound, so a cancelled or shorter request waited up to 10 s, and a host's `takesImages` that never returned held the request forever. A wait the run's cancel cuts fails `aborted`, and one the deadline cuts fails `timeout`, including a node's `timeoutMs`. Nothing was sent in either case, and the error says so (`unsent`), so through `judgeFromProviders` neither becomes `outcome_unknown`. The catalog read itself is shared and is not cut: it goes on under its own 10 s timeout for the requests after it.
