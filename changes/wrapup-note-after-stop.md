---
packages: @parcha/agentrun-serve
kind: fix
---
A capped run's wrap-up note is carried by the next request when the request it was given never leaves. On another harness, that happens when a stop refuses the request after its admission (a park, a halt, the cancel); the first request after a park, the resumed turn's first, went without the note, and only the one after it carried it. On pi, it happens when the request's send throws as it is made: the note stayed pending on a request that never existed, and the run was never told.
