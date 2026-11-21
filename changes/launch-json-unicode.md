---
packages: @parcha/agentrun-serve
kind: fix
---
On Postgres, a run whose input or text holds an escaped NUL (`\u0000`) or a lone surrogate no longer breaks the store's reads of its launch body, its commands or its journal. The affected reads were an agent's learning starts, the runs made from a run, a run's purge, a reopen, a claim, a trigger's queued message and the start sweep of runs of unknown cost. Postgres keeps such text, but its json functions refuse the whole document over one escape, and a read that scans every launch failed for every run. Outside a transaction, each read retries on that refusal against a copy with those escapes blanked. Inside a transaction, where a refused statement can't be retried, the read uses the copy from the start. Learning starts come back as written: a run's `learning` member is never taken from a blanked copy.
