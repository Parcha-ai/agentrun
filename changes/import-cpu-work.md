---
packages: @parcha/agentrun-serve, repo
kind: fix
---
Reduce repeated work when importing large Codex histories and discovering existing connector sessions. Codex transcript reconstruction merges deferred user messages in one ordered pass. Connector discovery allocates session and project identities in a batch while retaining locked, durable canonical IDs and connection consent checks.
