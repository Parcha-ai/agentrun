---
packages: @parcha/agentrun-serve
kind: fix
---
A browser session's open is durable before its vendor creates it: serve's browser spend records it in the run's journal (`agentrun.browser_session_open`: the tag, the conversation, the provider) and syncs the journal (barrier `browserSessionOpen`) through pi-browser's `beforeCreate`, before the vendor is asked. On a run journal at `synchronous = NORMAL`, a box loss after the create never leaves a billed session that no record names: the next process finds it by its tag and releases it. At FULL (today) it changes nothing; it bites at NORMAL.
