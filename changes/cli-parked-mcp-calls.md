---
packages: @parcha/agentrun-serve
kind: fix
---
A Claude Code or Codex run whose MCP call waits for approval now shows that call on its Timeline while it waits, with its approval beside it, and the call runs once when allowed, even if the runner that parked it goes in between. A stop while the call waits withdraws it: the run stops cleanly instead of being picked up again and again, and the call's row says it was not run. A stop while an allowed MCP call is running cuts that call at the server. A Claude Code or Codex call cut by a crash reads interrupted on the Timeline, in the words the model was given, instead of "failed: no detail". A Timeline page no longer reports a waiting run before the rows that led to it.
