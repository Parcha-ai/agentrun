---
packages: @parcha/agentrun-serve
kind: fix
---
A browser session kept across a reopen no longer holds its down time twice under a spend cap: once its first charge after the reopen books that time, its reserve on the run's ledger is one stretch again, so the run's next call is no longer refused for room the run never spends.
A new browser session whose reserve the cap refuses now pauses the run in the cap's words and logs `browser_reserve_refused`, where before the refusal went unread and the session ran on with its next stretch held nowhere.
