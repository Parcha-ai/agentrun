---
packages: @parcha/agentrun-serve
kind: feature
---
**A run's gateway: its model calls and network tools through serve's keys, reached by a per-run token**
- `startRunGateway` starts a gateway for one run, on a unix socket of mode 0600 in a directory serve names, or on the loopback interface. It mints a token of 32 random bytes, compares it in constant time, and never writes it to its log or into an answer. `revoke()` makes every later request 401 and aborts the ones in flight. Nothing starts it yet.
- Model calls go to a provider mounted under its own path (`/anthropic/v1/messages`, `/openai/v1/responses`) in that provider's own protocol, with the run's token where the protocol carries a key. The model proxy's core forwards them with serve's credential, so the client never holds it. `anthropicGatewayPolicy` and `responsesGatewayPolicy` let through what pi-ai's clients and the harnesses' session proxies send, for the run's models only. They refuse provider-hosted tools, MCP servers, containers, content the provider would fetch from a URL, and files or responses the provider holds.
- `POST /tools/<name>` with `{ callId, args }` runs one of the run's host tools and answers `{ text, isError }`. A replay-safe tool runs once per call id, and a repeat gets the first answer. A tool that runs at most once refuses a repeat with 409.
