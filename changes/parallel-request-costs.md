---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A pi run's model requests that answer at about the same time are each priced at their own cost. When one turn started several `subagent` calls, the child whose answer asked first was given every child's booking and the others $0, so the run page's Timeline and Dev tools tab and `GET /v2/runs/{id}/trace` showed one request at the sum (three requests of the same tokens at $0.02163, $0.01266 and $0.04326, say) and others at $0. Each answer now reads the bookings of its own conversation's requests. The run's cost was right throughout and does not change; a run already recorded keeps the per-request figures it was written with.
The session's model proxy takes a new request header, `x-agentrun-conversation` (`CONVERSATION_HEADER`, exported from `@parcha/agentrun-kernel/host`): a client may name the conversation a request is asked in, an id-shaped label of its own. The proxy tells the host with the request (`ProxyRequest.conversation`, `ModelRequest.conversation`) and never sends the header to the provider. A request that names none is asked as before.
