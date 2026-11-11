---
packages: @parcha/agentrun-serve
kind: fix
---
A run on a CLI harness (claude-agent, codex, opencode) now counts its tokens and its model requests in its metrics, and GET /v2/stats' analytics sum them, as a pi run's are. They are what the run's model proxy booked each request at, which the run's cost already came from; before, every CLI run read 0 requests and 0 tokens. A request booked with no usage, or sent and never answered, is counted unmetered, in no token sum; one answered at no known price keeps its tokens, its cost unknown.
Upgrading: nothing to do.
