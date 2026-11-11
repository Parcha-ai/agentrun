---
packages: @parcha/agentrun-serve
kind: breaking
---
Browser hand-over requests an earlier server wrote as files in a run's workspace (`work/browser-ask/`) are not read. Who breaks: a run that is waiting on a hand-over when the server is upgraded; its wait ends when the request expires, and the agent can ask again. To avoid it, answer or cancel pending hand-overs before upgrading.
