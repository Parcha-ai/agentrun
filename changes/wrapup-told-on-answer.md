---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: fix
---
A capped run's wrap-up note counts as told only once a request carrying it is answered, on every harness. A request the provider never answers, one lost on the way, one cut, one stopped part way, or one that never leaves, leaves the note for the next request, which carries it. Before, the note counted as told as soon as a request carrying it was admitted, so a retry after a failed request went without it, and the run could reach its cap unwarned. On another harness, a note told in an answered request is never told again in a later process, even if the row that shows it was lost: the row is rebuilt from the answered request's own record. On pi, the run's wrap-up row, written once the carrying request is answered, is what a later process reads.

Upgrading: a host that implements the kernel's `ModelPort` may return `note` in a request's admission (written on its `runner.turn` record when it ends) and read `ended` on `request_end`; both are optional.
