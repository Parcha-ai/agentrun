---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
OpenRouter runs book what OpenRouter charged; routers need no cap or a read-back cost; a rate limit inside a stream shows as refused.
- A request on an OpenRouter model is booked at the cost OpenRouter states in the answer's usage (with your own provider key, its fee plus the provider's charge). The price table's figure is kept beside it (`tableUsd`). A cap still holds each request at list price before it leaves. A stated cost that is missing, not a number, or above that hold is not used: the table's figure is booked instead.
- OpenRouter's routers (`openrouter/auto`, `openrouter/free` and the others) have no price here, because the model they pick is not known in advance. A run with a spend cap is refused before it starts. A run without one is booked at the cost OpenRouter reports, else unknown, never $0.
- A rate limit that OpenRouter sends inside a successful (200) stream is booked as refused at $0, and the run's record keeps the provider's message.
- Kernel: `startModelProxy` takes `usageCost: true` to book a cost stated in the answer's usage. `Ended` gains `tableUsd` on an answer and `{ end: "nothing", label: "refused", reason }`. `bookRequest` books the table's figure (rule `answered:over_hold`) when a reported figure is above the hold.
- Not yet: claude-agent, codex and opencode runs on OpenRouter still book at the table price. Routers and in-stream rate limits are handled on those harnesses too.
