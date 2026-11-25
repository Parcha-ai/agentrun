---
packages: @parcha/agentrun-kernel
kind: fix
---
A capped run stopped while a model request was out on a provider served through its own route (one that does not speak Anthropic's Messages API) now counts that request as a stop, at what streamed plus the stop's 1,024-token allowance, never at the whole of what its cap held for it.
