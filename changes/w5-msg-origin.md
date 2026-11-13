---
packages: @parcha/agentrun-serve
kind: breaking
---
`ServeOptions.messageOrigin` is gone. Nothing read it since runs moved to the runner, so a message posted to a run never took the origin it returned. Code that passed it drops the option; the only message the server writes with an origin is a raised cap's follow-up, which the runner marks itself.
