---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: fix
---
A model request under a spend cap is booked by one rule on every harness: the kernel's `bookRequest`, from how the
request ended (`Ended`). The rule is never to under-count.
- **A whole answer** books its own cost, or its hold when that cost cannot be read. On pi, that used to make what the run
  had spent unknown.
- **An error status before any event**, or a request refused at connect, books nothing.
- **A failure once the request left, a gateway's 504 or 524, or an answer after an attempt that was lost** books the
  hold.
- **A stop** books what streamed: its content, and the part of a hidden reasoning budget that did not stream.
- **A content-filter end** on pi books the hold: pi-ai ends it as an error after events, which can have been billed. On
  the proxy, a filtered answer is an answer and books its own cost.

On pi, the cap now gives pi-ai a fetch that records each attempt pi-ai makes, so a reset before any response books the
hold where it booked $0, and a 429 then an answer is priced once. An API whose transport that fetch cannot see (Codex's
WebSocket, Bedrock, Google, Cloudflare) books the hold for a failure before any event. A later process reads the figure
this one booked: a pi request that failed before any event marks its hold, and the runner writes `bookedUsd` and `rule` on
its records. The model proxy passes how a request ended as `afterRequest`'s third argument.
If the store cannot take such a mark within 15 s, the request fails, saying its end could not be recorded, and a later
process reads it at its hold.
