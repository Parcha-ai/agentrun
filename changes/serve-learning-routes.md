---
packages: @parcha/agentrun-serve
kind: feature
---
AgentRun Server shows what each run learned and what an agent knows, through its own `/v2` learning routes: a run's learning state, its memo and its diff (`proposed` while its branch waits, `landed` once merged), approve and refuse for a held plan, and an agent's notes, skills and workflows at `main`, one file of it, the log of its merges, and retire.
- Reads come from the bare learning repository with git's plumbing, so any number run at once. Every text passes through the host's secrets at read time (a value made secret later reads `[redacted]`), and a file holding one shows its path and the rule only.
- A run's text is untrusted on this origin: the memo and a file answer with an explicit type, `nosniff`, and `content-security-policy: sandbox`. The diff is bounded at 64 KB a file, 200 files and 1 MB in all, and the log's `limit` at 100.
- Who approves or refuses is the request's credential, never its body. `409 not_awaiting_approval` is new.
