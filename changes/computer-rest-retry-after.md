---
packages: @parcha/agentrun-computer
kind: fix
---
A hosted provider's REST call that is sent again after a refusal (a 429, a 503, or any answer its retry rule names) now waits as long as the answer's `Retry-After` header asks, in seconds or as an HTTP date, when that is longer than its own backoff. Before, it sent again after the backoff alone (from 500 ms), which the vendor refused again. A `Retry-After` longer than the call's timeout is not waited out: the call fails then, with the code it already had (`limit` for a 429) and words that give the wait the vendor asked for.
